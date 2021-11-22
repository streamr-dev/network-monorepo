module.exports = {
    preset: 'ts-jest',
    globals: {
        'ts-jest': {
            babelConfig: false,
        }
    },
    clearMocks: true,
    testEnvironment: 'node',
    cacheDirectory: "node_modules/.cache/jest",
}
