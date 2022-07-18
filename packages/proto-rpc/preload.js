// Loads non-browser compatible components to Electron's NodeJS sandbox during tests
process.once("loaded", () => {
    window.Express = require('express')
    window.HTTP = require('http')
    window.HTTPS = require('https')
    window.NodeJsBuffer = Buffer
})
