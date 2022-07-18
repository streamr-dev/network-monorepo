// Add important parts of Jest to the Karma/Jasmine browser-test runtime's global scope
// the jest.fn() API
import * as jestMock from 'jest-mock'
import expect from 'expect'
import { ModernFakeTimers } from '@jest/fake-timers'

// importing jest-extended directly relies on global.expect to be set
// importing the matchers and calling expect.extend manually
// prevents tests failing due to global.expect not being set
import jestExtendedMatchers from 'jest-extended/dist/matchers'

let jest = jestMock
const timers = new ModernFakeTimers({global: window, config: null })

// prevent navigation
// without this karma fails the suite with "Some of your tests did a full page reload!"
// not clear what is causing the reload.
window.onbeforeunload = () => 'unload prevented'

jest.advanceTimersByTime = timers.advanceTimersByTime
jest.advanceTimersToNextTimer = timers.advanceTimersToNextTimer
jest.clearAllTimers = timers.clearAllTimers
jest.dispose = timers.dispose
jest.getRealSystemTime = timers.getRealSystemTime
jest.getTimerCount = timers.getTimerCount
jest.reset = timers.reset
jest.runAllTicks = timers.runAllTicks
jest.runAllTimers = timers.runAllTimers
jest.runOnlyPendingTimers = timers.runOnlyPendingTimers
jest.setSystemTime = timers.setSystemTime
jest.useFakeTimers = timers.useFakeTimers
jest.useRealTimers = timers.useRealTimers
jasmine.DEFAULT_TIMEOUT_INTERVAL = 15000
// eslint-disable-next-line no-underscore-dangle
jest._checkFakeTimers = timers._checkFakeTimers

Object.assign(jest, timers)

expect.extend(jestExtendedMatchers)

// Add missing Jest functions
window.test = window.it
window.test.each = (inputs) => (testName, test) =>
    inputs.forEach((args) => window.it(testName, () => test(...args)))
window.test.todo = function () {
    return undefined
}

window.expect = expect
window.setImmediate = setTimeout
window.clearImmediate = clearTimeout
window.jest = jestMock
