#  Starting network-monorepo development from scratch on an M1 Mac

These instructions were tested on 

```
macOS Monterey Version 12.3
Apple M1 Max
nodejs v16.14.2
npm 8.5.0
```

## Introduction

The current (April 19th 2022) main branch of streamr-network-monorepo does not install out-of-the-box on an M1 Mac using `npm ci`, but rather requires deleting the 
`package-lock.json` file, and installing from scratch using `npm install`. 

Running `npm install` also requires a couple of preparations, because 

* Python 2 is not available by default on macOS 12.3 (which prevents the package weak-napi from compiling)
* Package node-datachannel does not come with pre-compiled M1 binaries, and gets recompiled


## Installation

* Install Homebrew with XCode command line tools: https://mac.install.guide/commandlinetools/3.html
* Install python 2.7:
```
brew install pyenv
pyenv install 2.7.18
cat 2.7.18 > ~/.pyenv/version
```

Make sure that the python installation works:
```
% python --version
Python 2.7.18
```

* Install the prerequsites for compiling node-datachannel:
```
brew install openssl
brew install cmake
export OPENSSL_ROOT_DIR=/opt/homebrew/Cellar/openssl@1.1/1.1.1n/  
export OPENSSL_INCLUDE_DIR=/opt/homebrew/Cellar/openssl@1.1/1.1.1n/include
```

* Install network-monorepo from scratch: 
```
npm install
```
