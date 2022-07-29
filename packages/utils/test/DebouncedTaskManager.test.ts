import { DebouncedTaskManager } from '../src/DebouncedTaskManager'
import { wait } from '../src/wait'

const TIMEOUT = 100
const MARGIN = 10

describe(DebouncedTaskManager, () => {
    let manager: DebouncedTaskManager<string>

    beforeEach(() => {
        manager = new DebouncedTaskManager<string>()
    })

    it('simple schedule', async () => {
        const task = jest.fn()
        manager.schedule('foo', TIMEOUT, task)
        await wait(TIMEOUT + MARGIN)
        expect(task).toHaveBeenCalledTimes(1)
        expect(task).toHaveBeenCalledWith('foo')
    })

    it('re-scheduling causes debounce', async () => {
        const task = jest.fn()
        for (let i = 0; i < 10; ++i) {
            manager.schedule('foo', TIMEOUT, task)
            await wait(TIMEOUT / 2)
            expect(task).toHaveBeenCalledTimes(0)
        }
        await wait(TIMEOUT / 2 + MARGIN)
        expect(task).toHaveBeenCalledTimes(1)
    })

    it('scheduling is key-specific', async () => {
        const fooTask = jest.fn()
        const barTask = jest.fn()
        manager.schedule('foo', TIMEOUT, fooTask)
        await wait(TIMEOUT / 2)
        manager.schedule('bar', TIMEOUT, barTask)
        await wait(TIMEOUT / 2 + MARGIN)
        expect(fooTask).toHaveBeenCalledTimes(1)
        expect(barTask).toHaveBeenCalledTimes(0)
        await wait(TIMEOUT / 2 + MARGIN)
        expect(fooTask).toHaveBeenCalledTimes(1)
        expect(barTask).toHaveBeenCalledTimes(1)
        expect(fooTask).toHaveBeenCalledWith('foo')
        expect(barTask).toHaveBeenCalledWith('bar')
    })

    it('unscheduleAll clears all tasks', async () => {
        const fooTask = jest.fn()
        const barTask = jest.fn()
        manager.schedule('foo', TIMEOUT, fooTask)
        manager.schedule('bar', TIMEOUT, barTask)
        await wait(TIMEOUT / 2)
        manager.unscheduleAll()
        await wait(TIMEOUT / 2 + MARGIN)
        expect(fooTask).toHaveBeenCalledTimes(0)
        expect(barTask).toHaveBeenCalledTimes(0)

    })
})
