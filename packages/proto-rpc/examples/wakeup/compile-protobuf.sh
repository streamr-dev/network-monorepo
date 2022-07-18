#!/bin/bash

mkdir -p ./proto
npx protoc -I $(pwd)/../../protos --ts_out $(pwd)/proto --ts_opt server_generic,generate_dependencies --proto_path $(pwd) WakeUpRpc.proto
