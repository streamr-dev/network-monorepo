mkdir -p ./src/proto
npx protoc --ts_out ./src/proto --ts_opt server_generic,generate_dependencies --proto_path protos protos/ProtoRpc.proto
mkdir -p ./test/proto
npx protoc --ts_out ./test/proto --ts_opt server_generic,generate_dependencies --proto_path test/protos test/protos/TestProtos.proto
