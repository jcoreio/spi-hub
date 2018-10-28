#!/usr/bin/env bash
rsync -r --exclude node_modules * pi:/service/spi-hub
