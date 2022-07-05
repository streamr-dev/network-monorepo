/* eslint-disable prefer-template */

process.env.NODE_ENV = process.env.NODE_ENV || 'development' // set a default NODE_ENV

const path = require('path')
const fs = require('fs')

const webpack = require('webpack')
const TerserPlugin = require('terser-webpack-plugin')
const LodashWebpackPlugin = require('lodash-webpack-plugin')
const { merge } = require('webpack-merge')
const { BundleAnalyzerPlugin } = require('webpack-bundle-analyzer')
const { GitRevisionPlugin } = require('git-revision-webpack-plugin')
const NodePolyfillPlugin = require('node-polyfill-webpack-plugin')

const pkg = require('./package.json')

const gitRevisionPlugin = new GitRevisionPlugin()

const libraryName = pkg.name

module.exports = (env, argv) => {
    const isProduction = argv.mode === 'production' || process.env.NODE_ENV === 'production'

    const analyze = !!process.env.BUNDLE_ANALYSIS

    const commonConfig = {
        cache: {
            type: 'filesystem',
        },
        name: 'streamr-client',
        mode: isProduction ? 'production' : 'development',
        entry: {
            'streamr-client': path.join(__dirname, 'src', 'index-browser.ts'),
        },
        devtool: 'source-map',
        output: {
            umdNamedDefine: true,
        },
        optimization: {
            minimize: false,
            moduleIds: 'named',
        },
        module: {
            rules: [
                {
                    test: /(\.jsx|\.js|\.ts)$/,
                    exclude: /(node_modules|bower_components)/,
                    use: {
                        loader: 'babel-loader',
                        options: {
                            configFile: path.resolve(__dirname, '.babel.browser.config.js'),
                            babelrc: false,
                            cacheDirectory: true,
                        }
                    }
                }
            ],
        },
        resolve: {
            modules: ['node_modules', ...require.resolve.paths(''), path.resolve('./vendor')],
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
        ],
        performance: {
            hints: 'warning',
        },
    }

    const clientConfig = merge({}, commonConfig, {
        target: 'web',
        output: {
            filename: '[name].web.js',
            libraryTarget: 'umd',
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
            // libraryExport: 'StreamrClient', // This fixes the above.
            globalObject: 'globalThis',
        },
        resolve: {
            alias: {
                stream: 'readable-stream',
                util: 'util',
                http: path.resolve('./src/shim/http-https.ts'),
                '@ethersproject/wordlists': require.resolve('@ethersproject/wordlists/lib/browser-wordlists.js'),
                https: path.resolve('./src/shim/http-https.ts'),
                crypto: require.resolve('crypto-browserify'),
                buffer: require.resolve('buffer/'),
                'node-fetch': path.resolve('./src/shim/node-fetch.ts'),
                'streamr-client-protocol': path.resolve('../protocol/src'),
                'streamr-network': path.resolve('../network/src/browser.ts'),
                [path.join(__dirname, '../network/src/connection/webrtc/NodeWebRtcConnection.ts$')]: require.resolve('streamr-network/src/connection/webrtc/BrowserWebRtcConnection.ts'),
                [path.join(__dirname, '../network/src/connection/ws/NodeClientWsEndpoint.ts$')]: require.resolve('streamr-network/src/connection/ws/BrowserClientWsEndpoint.ts'),
                [path.join(__dirname, '../network/src/connection/ws/NodeClientWsConnection.ts$')]: require.resolve('streamr-network/src/connection/ws/BrowserClientWsConnection.ts'),
                // swap out ServerPersistentStore for BrowserPersistentStore
                [path.resolve('./src/encryption/ServerPersistentStore')]: (
                    path.resolve('./src/encryption/BrowserPersistentStore.ts')
                ),
            },
            fallback: {
                module: false,
                fs: false,
                net: false,
                http: false,
                https: false,
                express: false,
                ws: false,
            }
        },
        plugins: [
            new NodePolyfillPlugin({
                excludeAliases: ['console'],
            }),
            new LodashWebpackPlugin(),
            ...(analyze ? [
                new BundleAnalyzerPlugin({
                    analyzerMode: 'static',
                    openAnalyzer: false,
                    generateStatsFile: true,
                })
            ] : [])
        ]
    })

    let clientMinifiedConfig

    if (isProduction) {
        clientMinifiedConfig = merge({}, clientConfig, {
            cache: false,
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
                filename: '[name].web.min.js',
            },
        })
    }
    return [clientConfig, clientMinifiedConfig].filter(Boolean)
}
