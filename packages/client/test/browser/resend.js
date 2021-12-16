/* eslint-disable no-undef */
const { v4: uuidv4 } = require('uuid')

describe('StreamrClient Resend', () => {
    const streamName = uuidv4()

    before((browser) => {
        // optionally forward url env vars as query params
        const restUrl = process.env.REST_URL ? `&REST_URL=${encodeURIComponent(process.env.REST_URL)}` : ''
        const browserUrl = `http://localhost:8880?streamName=${streamName}${restUrl}`
        // eslint-disable-next-line no-console
        console.info(browserUrl)
        return browser.url(browserUrl)
    })

    test('Test StreamrClient in Chrome Browser', (browser) => {
        browser
            .waitForElementVisible('body')
            .assert.titleContains('Test StreamrClient in Chrome Browser')
            .click('button[id=connect]')
            .assert.containsText('#result', 'connected')
            .click('button[id=create]')
            .pause(6000)
            .assert.containsText('#result', streamName)
            .assert.not.containsText('#error', 'Error')
            .click('button[id=permissions]')
            .assert.containsText('#result', 'stream_subscribe')
            .assert.containsText('#result', 'stream_get')
            .assert.not.containsText('#error', 'Error')
            .click('button[id=store]')
            .assert.containsText('#result', 'address')
            .assert.not.containsText('#error', 'Error')
            .click('button[id=subscribe]')
            .assert.containsText('#result', 'subscribed')
            .assert.not.containsText('#error', 'Error')
            .click('button[id=publish]')
            .pause(6000)
            .verify.containsText('#result', '{"msg":0}')
            .assert.not.containsText('#error', 'Error')
            .verify.containsText('#result', '{"msg":1}')
            .verify.containsText('#result', '{"msg":2}')
            .verify.containsText('#result', '{"msg":3}')
            .verify.containsText('#result', '{"msg":4}')
            .verify.containsText('#result', '{"msg":5}')
            .verify.containsText('#result', '{"msg":6}')
            .verify.containsText('#result', '{"msg":7}')
            .verify.containsText('#result', '{"msg":8}')
            .verify.containsText('#result', '{"msg":9}')
            .assert.containsText('#result', '[{"msg":0},{"msg":1},{"msg":2},{"msg":3},{"msg":4},{"msg":5},{"msg":6},{"msg":7},{"msg":8},{"msg":9}]')
            .assert.not.containsText('#error', 'Error')
            .pause(10000)
            .click('button[id=resend]')
            .pause(10000)
            .verify.containsText('#result', '{"msg":0}')
            .assert.not.containsText('#error', 'Error')
            .verify.containsText('#result', '{"msg":1}')
            .verify.containsText('#result', '{"msg":2}')
            .verify.containsText('#result', '{"msg":3}')
            .verify.containsText('#result', '{"msg":4}')
            .verify.containsText('#result', '{"msg":5}')
            .verify.containsText('#result', '{"msg":6}')
            .verify.containsText('#result', '{"msg":7}')
            .verify.containsText('#result', '{"msg":8}')
            .verify.containsText('#result', '{"msg":9}')
            .assert.containsText(
                '#result',
                'Resend: [{"msg":0},{"msg":1},{"msg":2},{"msg":3},{"msg":4},{"msg":5},{"msg":6},{"msg":7},{"msg":8},{"msg":9}]',
            )
            .click('button[id=disconnect]')
            .assert.containsText('#result', 'disconnected')
            .assert.not.containsText('#error', 'Error')
    })

    after(async (browser) => {
        browser.getLog('browser', (logs) => {
            logs.forEach((log) => {
                // eslint-disable-next-line no-console
                const logger = console[String(log.level).toLowerCase()] || console.log
                logger('[%s]: ', log.timestamp, log.message)
            })
        })
        return browser.end()
    })
})
