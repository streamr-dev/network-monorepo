mkdir -p ./src/proto
npx protoc --ts_out ./src/proto --ts_opt server_generic,generate_dependencies --proto_path protos protos/DhtRpc.proto

