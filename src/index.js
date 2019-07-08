import bunyan from 'bunyan';
import ChangesStream from 'changes-stream';
import asyncEach from 'async/each';
import asyncMap from 'async/map';
import {
  getAuthHeaders,
  getBaseUrl,
  getDbName,
  Librarian,
  mapChangeToSchema
} from '@scipe/librarian';
import createError from '@scipe/create-error';
import EventEmitter from 'events';

export default class Feed extends EventEmitter {
  constructor(config) {
    super();
    config = config || {};

    const dbName = getDbName(config);

    this.SEQ_SET = config.setSet || `${dbName}:seqset`;
    this.SEEN_SET = config.seenSet || `${dbName}:seenset`;

    this.SEQ_SET_MAX_SIZE = config.seqSetMaxSize || 50000;
    this.SEEN_SET_MAX_SIZE = config.seenSetMaxSize || 50000;

    let getBaseUrlOpts;
    if (getAuthHeaders(config).user && getAuthHeaders(config).pass) {
      getBaseUrlOpts = { basicAuth: true };
    } else {
      getBaseUrlOpts = { admin: true };
    }

    this.feedUrl = `${getBaseUrl(config, getBaseUrlOpts)}${dbName}`;
    this.filter = 'filter' in config ? config.filter : 'scienceai/admin';

    this.filterQueryParams = Object.keys(config.filterQueryParams || {}).reduce(
      (params, key) => {
        const value = config.filterQueryParams[key];
        let processed;
        switch (key) {
          case 'scope':
          case 'outscope':
            processed = Array.isArray(value) ? JSON.stringify(value) : value;
            break;

          default:
            processed = value;
            break;
        }

        params[key] = processed;
        return params;
      },
      {}
    );

    this.maxConcurrency = config.concurrency || 1; // how many items can be processed in parallel
    this.concurrency = 0;
    this.safe = config.safe;
    if (config.librarian) {
      this.librarian = config.librarian;
    } else {
      this.librarian = new Librarian(config);
      this.ownLibrarian = true;
    }

    const bunyanConfig = {
      name: 'feed',
      serializers: {
        err: bunyan.stdSerializers.err,
        res: res => {
          if (!res) return res;
          let data = {
            statusCode: res.statusCode
          };
          if (process.env.NODE_ENV === 'production') {
            data.header = res._header;
          }
          return data;
        },
        change: change => ({
          seq: change.seq,
          id: change.id
        })
      }
    };

    this.log = bunyan.createLogger(
      Object.assign({}, bunyanConfig, config.log || {})
    );

    this._handlers = [];
  }

  getLatestSeq(since, callback) {
    if (since != null) {
      callback(null, since);
    } else if (!this.safe) {
      callback(
        new Error(
          'since parameter must be defined or safe option must be set to true'
        )
      );
    } else {
      // get the oldest seq (as due to async processing we may need
      // to start before the latest seq if some of the earlier doc were
      // not done processing when `Feed` was last shut down.
      this.librarian.redis.zrange(this.SEQ_SET, 0, 0, (err, res) => {
        if (err) return callback(err);
        since = res[0] != null ? res[0] : 'now';
        callback(null, since);
      });
    }
  }

  setLatestSeq(change, callback) {
    if (!this.safe) {
      return callback(null);
    }
    // on CouchDB, doc.seq is an integer but on
    // Cloudant, doc.seq is a string in the format of
    // "number-idstring" reflecting distributed cluster
    // setup
    const score = parseInt(change.seq.toString().split('-')[0], 10);

    // We maintain a list of the change event already seen
    // as Cloudant and CouchDB 2.0 only guarante that all the
    // changes will be seen, but do not guarante that they
    // will only be seen once...

    let req = change.changes.reduce(
      (req, entry) =>
        req.zadd(this.SEEN_SET, score, `${change.id}-${entry.rev}`),
      this.librarian.redis.multi()
    );

    // we need to keep track of the seq already seen so
    // that we know reliably where to restart from
    req.zadd(this.SEQ_SET, score, change.seq);

    req.exec(err => {
      if (err) {
        this.log.error({ err, change }, 'in updating ordered sets');
      }

      // let's capp the set so that their size remains constant
      this.librarian.redis
        .multi()
        .zcard(this.SEEN_SET)
        .zcard(this.SEQ_SET)
        .exec((err, res) => {
          if (err) {
            callback(err);
          } else {
            const [seenSetSize, seqSetSize] = res;
            if (
              seenSetSize > this.SEEN_SET_MAX_SIZE ||
              seqSetSize > this.SEQ_SET_MAX_SIZE
            ) {
              let req = this.librarian.redis.multi();
              if (seenSetSize > this.SEEN_SET_MAX_SIZE) {
                req = req.zremrangebyrank(
                  this.SEEN_SET,
                  0,
                  seenSetSize - this.SEEN_SET_MAX_SIZE
                );
              }
              if (seqSetSize > this.SEQ_SET_MAX_SIZE) {
                req = req.zremrangebyrank(
                  this.SEQ_SET,
                  0,
                  seqSetSize - this.SEQ_SET_MAX_SIZE
                );
              }

              req.exec(callback);
            } else {
              callback(null);
            }
          }
        });
    });
  }

  /**
   * assess if a change was already seen
   */
  info(change, callback) {
    if (!this.safe) {
      return callback(null);
    }

    const req = change.changes.reduce(
      (req, entry) => req.zrank(this.SEEN_SET, `${change.id}-${entry.rev}`),
      this.librarian.redis.multi()
    );

    req.exec((err, res = []) => {
      if (err) {
        this.log.error(
          { err, change },
          'in checking if we have already seen the changes'
        );
      }

      const alreadySeen = !res.some(x => x == null);
      callback(null, alreadySeen);
    });
  }

  listen(since, callback) {
    if (arguments.length === 0) {
      since = undefined;
      callback = function() {};
    } else if (arguments.length === 1) {
      if (typeof since === 'function') {
        callback = since;
        since = undefined;
      } else {
        callback = function() {};
      }
    }

    this.getLatestSeq(since, (err, since) => {
      if (err) {
        this.log.fatal({ err, since }, 'error could not find since');
        return callback(err);
      }

      // first a workaround: if since is invalid, for instance if
      // since is a number different from 0 on cloudant (e.g `3`),
      // the stream may not flow (but may not error)... Cloudant does send a
      // 400 response though so we catch that here.
      this.librarian.db.get(
        {
          url: '/_changes',
          qs: {
            filter: this.filter,
            since,
            limit: 1
          }
        },
        (err, resp, body) => {
          if ((err = createError(err, resp, body))) {
            this.log.fatal(
              { err, since, filter: this.filter },
              'could not GET _changes'
            );
            return callback(err);
          }

          this.feed = new ChangesStream({
            db: this.feedUrl,
            filter: this.filter,
            query_params: this.filterQueryParams,
            include_docs: true,
            since
          });

          this.log.info({ since }, 'changes feed listening');
          this.emit('listening', since);

          this.feed.on('error', err => {
            this.log.fatal({ err }, 'error following changes feed');
            this.emit('error', err);
          });

          this.feed.on('data', change => {
            this.log.trace({ change, concurrency: this.concurrency }, 'change');

            this.lock(change, (err, lock) => {
              if (err) {
                this.log.trace({ err, change }, 'change is locked');
                return;
              }
              // check if we have already seen the change
              this.info(change, (err, alreadySeen) => {
                if (err) {
                  this.log.error(
                    { err, change },
                    'error checking if we have already seen the changes'
                  );
                }
                if (alreadySeen) {
                  this.log.trace(
                    { change },
                    'we have already seen this change'
                  );
                } else {
                  // Note: we set the latest seq first so that if it
                  // fails, we don't process the change as we will
                  // restart from the one before
                  this.setLatestSeq(change, err => {
                    if (err) {
                      this.log.fatal(
                        { err, change },
                        'error setting latest seq'
                      );
                      this.emit('error', err);
                    } else {
                      // handle backpressure
                      this.maybePause();
                      this.emit('change', change);
                      this.handleChange(change, err => {
                        if (err) {
                          this.log.error(
                            { err, change },
                            'in registered callback'
                          );
                        }
                        this.unlock(lock, err => {
                          if (err) {
                            this.log.error(err, 'error unlocking');
                          }
                          this.maybeResume();
                        });
                      });
                    }
                  });
                }
              });
            });
          });

          callback(null);
        }
      );
    });
    return this;
  }

  lock(change, callback) {
    if (!this.safe) {
      return callback(null);
    }
    asyncMap(
      change.changes,
      (entry, cb) => {
        const lockName = `${change.id}-${entry.rev}`;
        this.librarian.redlock.lock(`locks:${lockName}`, 1000 * 60 * 2, cb);
      },
      callback
    );
  }

  unlock(locks, callback) {
    if (!this.safe) {
      return callback(null);
    }
    asyncEach(
      locks,
      (lock, cb) => {
        lock.unlock(cb);
      },
      callback
    );
  }

  maybePause() {
    this.concurrency++;
    // back pressure
    if (this.concurrency > this.maxConcurrency) {
      if (this.feed) {
        this.log.trace(
          {
            concurrency: this.concurrency,
            maxConcurrency: this.maxConcurrency
          },
          'pausing changes feed to handle back pressure'
        );
        this.feed.pause();
      }
    }
  }

  maybeResume() {
    this.concurrency--;
    if (this.concurrency === 0 && this.handleStop) {
      this.handleStop();
      delete this.handleStop;
    }
    if (this.concurrency === this.maxConcurrency) {
      if (this.feed) {
        this.log.trace(
          {
            concurrency: this.concurrency,
            maxConcurrency: this.maxConcurrency
          },
          'resuming changes feed now that back pressure has been handled'
        );
        this.feed.resume();
      }
    }
  }

  stop(callback) {
    this.log.debug('Feed stopping');
    if (this.feed) {
      try {
        this.feed.destroy();
      } catch (e) {
        this.emit('error', e);
      }
    }

    if (callback) {
      if (this.concurrency === 0) {
        callback();
      } else {
        this.handleStop = callback;
      }
    }
  }

  close(callback) {
    if (this.ownLibrarian) {
      this.librarian.close();
    }
    this.stop(callback);
  }

  handleChange(change, callback) {
    if (!change.doc) {
      return callback(null);
    }
    const dataFeedItem = mapChangeToSchema(change);
    this.emit('data', dataFeedItem);
    asyncEach(
      this._handlers,
      (fn, cb) => {
        fn.call(this, dataFeedItem, err => {
          if (err) {
            this.log.error({ err }, 'in registered callback');
          }
          cb(null);
        });
      },
      callback
    );
  }

  register(fn) {
    if (!fn || typeof fn !== 'function') {
      const err = new Error('register: fn must be a function');
      this.log.error({ err });
      this.emit('error', err);
    } else {
      this._handlers.push(fn);
      this.emit('registered', fn.name);
      this.log.debug(`registered ${fn.name}`);
    }
    return this;
  }

  unregister(fn) {
    let ind = this._handlers.indexOf(fn);
    if (ind !== -1) {
      this._handlers.splice(ind, 1);
      this.emit('urregistered', fn.name);
      this.log.debug(`unregistered ${fn.name}`);
    }
    return this;
  }
}
