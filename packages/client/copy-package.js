const fs = require('fs')
const path = require('path')
// eslint-disable-next-line
const pkg = Object.assign({}, require('./package.json'))

delete pkg.scripts
delete pkg.private
// rewrite paths to be relative to dist
pkg.types = `./${path.relative('./dist', pkg.types)}`
pkg.main = `./${path.relative('./dist', pkg.main)}`
pkg.browser = `./${path.relative('./dist', pkg.browser)}`
pkg['react-native'] = `./${path.relative('./dist', pkg['react-native'])}`
pkg.exports['.'].browser = `./${path.relative('./dist', pkg.exports['.'].browser)}`
pkg.exports['.']['react-native'] = `./${path.relative('./dist', pkg.exports['.']['react-native'])}`
pkg.exports['.'].default.import = `./${path.relative('./dist', pkg.exports['.'].default.import)}`
pkg.exports['.'].default.require = `./${path.relative('./dist', pkg.exports['.'].default.require)}`

try {
    fs.mkdirSync('./dist/')
} catch (err) {
    if (err.code !== 'EEXIST') {
        throw err
    }
}
fs.writeFileSync('./dist/package.json', JSON.stringify(pkg, null, 2))
