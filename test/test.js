import assert from 'assert';
import uuid from 'uuid';
import Feed from '../src';

describe('feed', function() {
  this.timeout(10000);
  let feed;

  it('should work', done => {
    // we expect the action feed to emit these action type
    const expected = ['RegisterAction'];
    const seen = new Set();

    function handler(dataFeedItem, callback) {
      seen.add(dataFeedItem.item['@type']);
      callback(null);

      if (seen.size === expected.length) {
        assert(expected.every(type => seen.has(type)));
        done();
      }
    }

    feed = new Feed({
      log: {
        name: 'test-feed',
        level: 'fatal'
      },
      concurrency: 10,
      safe: true
    })
      .on('error', console.error.bind(console))
      .register(handler)
      .on('listening', function(since) {
        assert.equal(since, 'now');
      })
      .listen('now', err => {
        if (err) throw err;
        const registerAction = {
          '@type': 'RegisterAction',
          actionStatus: 'ActiveActionStatus',
          agent: {
            '@id': `user:${uuid.v4()}`,
            email: `${uuid.v4()}@science.ai`
          },
          instrument: {
            '@type': 'Password',
            value: uuid.v4()
          }
        };
        feed.librarian.post(registerAction, err => {
          if (err) return done(err);
        });
      });
  });

  after(done => {
    feed.close(done);
  });
});
