# SPI Hub

Interact with an SPI device from multiple processes

## Installing and Running

```
git clone https://github.com/jcoreio/spi-hub.git
cd spi-hub
npm install
./spiHub.js [SPI /dev entry] [, additional SPI /dev entry]
```

## Connecting

Use the `spi-hub-client` node.js package to connect to an SPI device from your program:

```
npm install --save spi-hub-client
```

```js
const SPIHubClient = require('spi-hub-client')

const spi = new SPIHubClient()

spi.on('devicesChanged', devices => {
  console.log('SPI devices changed', devices)
})

spi.on('message', message => {
  console.log('got SPI message', message)
})

setTimeout(() => spi.send({ bus: 0, device: 0, channel: 4, data: 'hello SPI' }), 1000)
```

## License

(The Apache 2.0 License)

Copyright (c) 2016 JCore Systems LLC

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.