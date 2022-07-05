// For a detailed explanation regarding each configuration property, visit:
// https://jestjs.io/docs/en/configuration.html
module.exports = {

    // Preset ts-jest
    preset: 'ts-jest',

    globals: {
        'ts-jest': {
            tsconfig: 'tsconfig.jest.json',
            babelConfig: false,
        }
    },

    // Automatically clear mock calls and instances between every test
    clearMocks: true,

    // An array of glob patterns indicating a set of files for which coverage information should be collected
    collectCoverageFrom: ['src/**'],

    // The directory where Jest should output its coverage files
    coverageDirectory: 'coverage',

    // The test environment that will be used for testing
    testEnvironment: 'node',

    // Default timeout of a test in milliseconds
    testTimeout: 15000,
    maxWorkers: 3,

    // This option allows use of a custom test runner
    testRunner: 'jest-circus/runner',

    testPathIgnorePatterns: ["/browser/", "/node_modules/"],

    setupFilesAfterEnv: ["jest-extended/all"],
}
