#!/bin/bash

mkdir -p ./proto
npx protoc --ts_out $(pwd)/proto --ts_opt server_generic,generate_dependencies --proto_path $(pwd) HelloRpc.proto
