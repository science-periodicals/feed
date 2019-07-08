# @scipe/feed

[![styled with prettier](https://img.shields.io/badge/styled_with-prettier-ff69b4.svg)](https://github.com/prettier/prettier)

sci.pe changes feed emitting schema.org `DataFeedItem`.

Note: this module is auto published to npm on CircleCI. Only run `npm version
patch|minor|major` and let CI do the rest.

## Usage

```js
import Feed from '@scipe/feed';

function sendEmail(dataFeedItem, callback) {
  // do something with dataFeedItem and callback([err]);
  // `this` is the feed
  callback();
}

var feed = new Feed()
             .on('error', console.error.bind(console))
             .on('change', function(change) { })
             .on('data', function(dataFeedItem) { })
             .on('listening', function(since) { })
             .register(sendEmail)
             .listen();

// later
setTimeout(() => {
  feed
    .unregister(sendEmail)
    .close();
}, 10000);
```

## Tests

Be sure that CouchDB and redis are running and run `npm test`.

## License

`@scipe/feed` is dual-licensed under commercial and open source licenses
([AGPLv3](https://www.gnu.org/licenses/agpl-3.0.en.html)) based on the intended
use case. Contact us to learn which license applies to your use case.
