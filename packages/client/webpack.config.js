/* eslint-disable prefer-template */
/* eslint-disable prefer-destructuring */

process.env.NODE_ENV = process.env.NODE_ENV || 'development' // set a default NODE_ENV

const path = require('path')

const webpack = require('webpack')
const TerserPlugin = require('terser-webpack-plugin')
const LodashWebpackPlugin = require('lodash-webpack-plugin')
const { merge } = require('webpack-merge')
const { BundleAnalyzerPlugin } = require('webpack-bundle-analyzer')
const { GitRevisionPlugin } = require('git-revision-webpack-plugin')

const pkg = require('./package.json')

const gitRevisionPlugin = new GitRevisionPlugin()

const libraryName = pkg.name

module.exports = (env, argv) => {
    const isProduction = argv.mode === 'production' || process.env.NODE_ENV === 'production'

    const analyze = !!process.env.BUNDLE_ANALYSIS

    const commonConfig = {
        mode: isProduction ? 'production' : 'development',
        entry: path.join(__dirname, 'src', 'StreamrClient.ts'),
        devtool: 'source-map',
        output: {
            umdNamedDefine: true,
        },
        optimization: {
            minimize: false,
        },
        module: {
            rules: [
                {
                    test: /(\.jsx|\.js|\.ts)$/,
                    exclude: /(node_modules|bower_components)/,
                    use: {
                        loader: 'babel-loader',
                        options: {
                            configFile: path.resolve(__dirname, '.babel.config.js'),
                            babelrc: false,
                            cacheDirectory: true,
                        }
                    }
                },
                {
                    test: /(\.jsx|\.js|\.ts)$/,
                    loader: 'eslint-loader',
                    exclude: /(node_modules|streamr-client-protocol|dist)/, // excluding streamr-client-protocol makes build work when 'npm link'ed
                },
            ],
        },
        resolve: {
            modules: [path.resolve('./node_modules'), path.resolve('./vendor'), path.resolve('./src')],
            extensions: ['.json', '.js', '.ts'],
        },
        plugins: [
            gitRevisionPlugin,
            new webpack.EnvironmentPlugin({
                NODE_ENV: process.env.NODE_ENV,
                version: pkg.version,
                GIT_VERSION: gitRevisionPlugin.version(),
                GIT_COMMITHASH: gitRevisionPlugin.commithash(),
                GIT_BRANCH: gitRevisionPlugin.branch(),
            })
        ]
    }

    const clientConfig = merge({}, commonConfig, {
        name: 'browser-lib',
        target: 'web',
        output: {
            libraryTarget: 'umd2',
            filename: libraryName + '.web.js',
            library: 'StreamrClient',
            // NOTE:
            // exporting the class directly
            // `export default class StreamrClient {}`
            // becomes:
            // `window.StreamrClient === StreamrClient`
            // which is correct, but if we define the class and export separately,
            // which is required if we do interface StreamrClient extends …:
            // `class StreamrClient {}; export default StreamrClient;`
            // becomes:
            // `window.StreamrClient = { default: StreamrClient, … }`
            // which is wrong for browser builds.
            // see: https://github.com/webpack/webpack/issues/706#issuecomment-438007763
            libraryExport: 'StreamrClient', // This fixes the above.
            globalObject: 'globalThis',
        },
        resolve: {
            modules: [
                'node_modules', // without this symlinked protocol won't find own dependencies
            ],
            alias: {
                stream: 'readable-stream',
                util: 'util',
                http: path.resolve(__dirname, './src/shim/http-https.js'),
                https: path.resolve(__dirname, './src/shim/http-https.js'),
                ws: path.resolve(__dirname, './src/shim/ws.js'),
                crypto: path.resolve(__dirname, 'node_modules', 'crypto-browserify'),
                buffer: path.resolve(__dirname, 'node_modules', 'buffer'),
                'node-fetch': path.resolve(__dirname, './src/shim/node-fetch.js'),
                'node-webcrypto-ossl': path.resolve(__dirname, 'src/shim/crypto.js'),
                'streamr-client-protocol': path.resolve(__dirname, 'node_modules/streamr-client-protocol/dist/src'),
                // swap out ServerPersistentStore for BrowserPersistentStore
                [path.resolve(__dirname, 'src/stream/encryption/ServerPersistentStore')]: (
                    path.resolve(__dirname, 'src/stream/encryption/BrowserPersistentStore')
                ),
            }
        },
        plugins: [
            new LodashWebpackPlugin(),
            new webpack.ProvidePlugin({
                process: 'process/browser',
                Buffer: ['buffer', 'Buffer'],
            }),
            ...(analyze ? [
                new BundleAnalyzerPlugin({
                    analyzerMode: 'static',
                    openAnalyzer: false,
                    generateStatsFile: true,
                }),
            ] : [])
        ]
    })

    let clientMinifiedConfig

    if (isProduction) {
        clientMinifiedConfig = merge({}, clientConfig, {
            name: 'browser-lib-min',
            optimization: {
                minimize: true,
                minimizer: [
                    new TerserPlugin({
                        parallel: true,
                        terserOptions: {
                            ecma: 2018,
                            output: {
                                comments: false,
                            },
                        },
                    }),
                ],
            },
            output: {
                filename: libraryName + '.web.min.js',
            },
        })
    }

    const reactNativeConfig = merge({}, commonConfig, {
        name: 'react-native-lib',
        target: 'web',
        output: {
            library: {
                type: 'umd2',
                name: 'StreamrClient'
            },
            filename: libraryName + '.rn.js',
        },
        externals: [
            {
                'react-native': true,
                '@react-native-async-storage/async-storage/src/AsyncStorage.native': '@react-native-async-storage/async-storage/src/AsyncStorage.native',
            }
        ],
        resolve: {
            modules: [
                'node_modules', // without this symlinked protocol won't find own dependencies
            ],
            alias: {
                stream: 'readable-stream',
                util: 'util',
                http: path.resolve(__dirname, './src/shim/http-https.js'),
                https: path.resolve(__dirname, './src/shim/http-https.js'),
                ws: path.resolve(__dirname, './src/shim/ws.js'),
                crypto: path.resolve(__dirname, 'node_modules', 'crypto-browserify'),
                buffer: path.resolve(__dirname, 'node_modules', 'buffer'),
                'node-fetch': path.resolve(__dirname, './src/shim/node-fetch.js'),
                'node-webcrypto-ossl': path.resolve(__dirname, 'src/shim/crypto.js'),
                'streamr-client-protocol': path.resolve(__dirname, 'node_modules/streamr-client-protocol/dist/src'),
                // swap out ServerPersistentStore for ReactNativePersistentStore
                [path.resolve(__dirname, 'src/stream/encryption/ServerPersistentStore')]: (
                    path.resolve(__dirname, 'src/stream/encryption/ReactNativePersistentStore')
                ),
            },
            conditionNames: ['react-native'],
            mainFields: ['react-native', 'browser', 'main']
        },
        plugins: [
            new LodashWebpackPlugin(),
            new webpack.ProvidePlugin({
                process: 'process/browser',
                Buffer: ['buffer', 'Buffer'],
            }),
            ...(analyze ? [
                new BundleAnalyzerPlugin({
                    analyzerMode: 'static',
                    openAnalyzer: false,
                    generateStatsFile: true,
                }),
            ] : [])
        ]
    })

    return [clientConfig, clientMinifiedConfig, reactNativeConfig].filter(Boolean)
}
