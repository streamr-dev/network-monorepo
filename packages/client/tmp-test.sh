#!/bin/bash
for i in {1..50}; do
    echo "Attempt: $i"
    npx jest --forceExit test/unit/PushBuffer.test.ts
    if [[ "$?" != '0' ]]; then
        echo "Failed after $i attempts"
        exit 1
    fi
done
