const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const featureCode = fs.readFileSync(
    path.resolve(__dirname, '../../features/moe-chat-media-auto-select.js'),
    'utf8'
);

describe('Moe chat media auto-select', () => {
    function createPage({ enabled = true, media = 'digital', options = ['Digital', 'Print'] } = {}) {
        const dom = new JSDOM(`<!doctype html><html><body>
            <div id="ptb-header"><mo-icon name="${media}"></mo-icon></div>
            <iframe name="Messaging window"></iframe>
        </body></html>`, {
            url: 'https://groupmuk-prisma.mediaocean.com/campaign-management/#campaign-id=CP123',
            runScripts: 'outside-only'
        });
        const { window } = dom;
        const frame = window.document.querySelector('iframe');
        const chatDocument = frame.contentDocument;
        chatDocument.body.innerHTML = `
            <div data-garden-id="containers.field">
                <div id="media-label">Media</div>
                <div id="media-trigger" data-garden-id="dropdowns.combobox.trigger" aria-controls="media-listbox">
                    <input id="media-input" role="combobox" aria-labelledby="media-label" aria-controls="media-listbox" value="-">
                </div>
            </div>
            <button id="send" type="button">Send</button>
        `;

        let storageListener;
        let sendCount = 0;
        const sendButton = chatDocument.getElementById('send');
        sendButton.addEventListener('click', () => { sendCount += 1; });

        const trigger = chatDocument.getElementById('media-trigger');
        trigger.addEventListener('click', () => {
            if (chatDocument.getElementById('media-listbox')) return;
            const listbox = chatDocument.createElement('ul');
            listbox.id = 'media-listbox';
            listbox.setAttribute('role', 'listbox');
            options.forEach((label, index) => {
                const option = chatDocument.createElement('li');
                option.id = `media-option-${index}`;
                option.setAttribute('role', 'option');
                option.textContent = label;
                option.addEventListener('click', () => {
                    chatDocument.getElementById('media-input').value = label;
                });
                listbox.appendChild(option);
            });
            chatDocument.body.appendChild(listbox);
        });

        window.chrome = {
            storage: {
                sync: {
                    get: jest.fn((defaults, callback) => callback({ ...defaults, moeChatMediaAutoSelectEnabled: enabled }))
                },
                onChanged: {
                    addListener: jest.fn(listener => { storageListener = listener; })
                }
            }
        };
        window.opsDiagnostics = { record: jest.fn() };
        window.eval(featureCode);
        window.moeChatMediaAutoSelectFeature.initialize();

        return {
            dom,
            window,
            chatDocument,
            sendButton,
            get sendCount() { return sendCount; },
            storageListener
        };
    }

    afterEach(() => {
        jest.useRealTimers();
    });

    test('detects the campaign media icon, selects the matching custom option, and sends once', () => {
        jest.useFakeTimers();
        const page = createPage();

        expect(page.window.moeChatMediaAutoSelectFeature.getCampaignMediaType()).toBe('Digital');
        page.window.moeChatMediaAutoSelectFeature.scan();
        jest.runAllTimers();

        expect(page.chatDocument.getElementById('media-input').value).toBe('Digital');
        expect(page.sendCount).toBe(1);
        expect(page.window.opsDiagnostics.record).toHaveBeenCalledWith(expect.objectContaining({
            source: 'moe-chat-media',
            operation: 'auto-select-media',
            outcome: 'success'
        }));
        page.dom.window.close();
    });

    test('sends on the next task instead of waiting on a fixed delay', () => {
        jest.useFakeTimers();
        const page = createPage();

        page.chatDocument.getElementById('media-trigger').click();
        page.window.moeChatMediaAutoSelectFeature.scan();

        expect(page.sendCount).toBe(0);
        jest.advanceTimersByTime(0);

        expect(page.sendCount).toBe(1);
        page.dom.window.close();
    });

    test('does not send when the campaign media is unavailable in Moe', () => {
        jest.useFakeTimers();
        const page = createPage({ options: ['Print'] });

        page.window.moeChatMediaAutoSelectFeature.scan();
        jest.runAllTimers();

        expect(page.sendCount).toBe(0);
        expect(page.chatDocument.getElementById('media-input').value).toBe('-');
        page.dom.window.close();
    });

    test('stops pending work when the setting is switched off', () => {
        jest.useFakeTimers();
        const page = createPage({ enabled: false });

        page.window.moeChatMediaAutoSelectFeature.scan();
        jest.runOnlyPendingTimers();
        expect(page.sendCount).toBe(0);
        expect(page.chatDocument.getElementById('media-input').value).toBe('-');

        page.storageListener({ moeChatMediaAutoSelectEnabled: { newValue: true } }, 'sync');
        page.window.moeChatMediaAutoSelectFeature.scan();
        page.storageListener({ moeChatMediaAutoSelectEnabled: { newValue: false } }, 'sync');
        jest.runAllTimers();

        expect(page.sendCount).toBe(0);
        page.dom.window.close();
    });

    test('detects Print campaign icon, selects Print option, and sends automatically', () => {
        jest.useFakeTimers();
        const page = createPage({ media: 'print', options: ['Digital', 'Print'] });

        expect(page.window.moeChatMediaAutoSelectFeature.getCampaignMediaType()).toBe('Print');
        page.window.moeChatMediaAutoSelectFeature.scan();
        jest.runAllTimers();

        expect(page.chatDocument.getElementById('media-input').value).toBe('Print');
        expect(page.sendCount).toBe(1);
        expect(page.window.opsDiagnostics.record).toHaveBeenCalledWith(expect.objectContaining({
            source: 'moe-chat-media',
            operation: 'auto-select-media',
            outcome: 'success',
            details: expect.objectContaining({
                mediaType: 'Print'
            })
        }));
        page.dom.window.close();
    });

    test('refreshes campaign media when Prisma swaps the icon without changing the URL', () => {
        const page = createPage({ media: 'digital' });
        const icon = page.window.document.querySelector('#ptb-header mo-icon');

        expect(page.window.moeChatMediaAutoSelectFeature.getCampaignMediaType()).toBe('Digital');
        icon.setAttribute('name', 'print');
        expect(page.window.moeChatMediaAutoSelectFeature.getCampaignMediaType()).toBe('Print');

        icon.remove();
        expect(page.window.moeChatMediaAutoSelectFeature.getCampaignMediaType()).toBeNull();
        page.window.moeChatMediaAutoSelectFeature.resetCache();
        expect(page.window.moeChatMediaAutoSelectFeature.getLastTimings()).toBeNull();
        page.dom.window.close();
    });

    test('captures timestamps for prompt, option list, option selection, and send click in diagnostics and feature API', () => {
        jest.useFakeTimers();
        const page = createPage({ media: 'digital' });

        page.window.moeChatMediaAutoSelectFeature.scan();
        jest.runAllTimers();

        const lastTimings = page.window.moeChatMediaAutoSelectFeature.getLastTimings();
        expect(lastTimings).not.toBeNull();
        expect(typeof lastTimings.promptInsertedAt).toBe('number');
        expect(typeof lastTimings.optionListInsertedAt).toBe('number');
        expect(typeof lastTimings.optionSelectedAt).toBe('number');
        expect(typeof lastTimings.sendClickedAt).toBe('number');
        expect(lastTimings.sendClickedAt).toBeGreaterThanOrEqual(lastTimings.optionSelectedAt);
        expect(lastTimings.optionSelectedAt).toBeGreaterThanOrEqual(lastTimings.promptInsertedAt);

        expect(page.window.opsDiagnostics.record).toHaveBeenCalledWith(expect.objectContaining({
            source: 'moe-chat-media',
            operation: 'auto-select-media',
            outcome: 'success',
            details: expect.objectContaining({
                mediaType: 'Digital',
                promptInsertedAt: expect.any(Number),
                optionListInsertedAt: expect.any(Number),
                optionSelectedAt: expect.any(Number),
                sendClickedAt: expect.any(Number),
                totalDurationMs: expect.any(Number)
            })
        }));
        page.dom.window.close();
    });

    test('triggers send on mutation when Send button was initially disabled', async () => {
        jest.useFakeTimers();
        const page = createPage();
        const sendBtn = page.chatDocument.getElementById('send');
        sendBtn.setAttribute('disabled', 'true');

        // Open options and scan
        page.chatDocument.getElementById('media-trigger').click();
        page.window.moeChatMediaAutoSelectFeature.scan();

        // Advance task 0
        jest.advanceTimersByTime(0);
        // Button was disabled, so send not yet clicked
        expect(page.sendCount).toBe(0);
        expect(jest.getTimerCount()).toBe(0);

        // React re-renders and enables the Send button (removing disabled attribute)
        sendBtn.removeAttribute('disabled');

        // Allow microtask (MutationObserver callback) to run
        await Promise.resolve();

        expect(page.sendCount).toBe(1);
        page.dom.window.close();
    });

    test('does not send if setting is toggled off while awaiting Send button to enable', async () => {
        jest.useFakeTimers();
        const page = createPage();
        const sendBtn = page.chatDocument.getElementById('send');
        sendBtn.setAttribute('disabled', 'true');

        page.chatDocument.getElementById('media-trigger').click();
        page.window.moeChatMediaAutoSelectFeature.scan();
        jest.advanceTimersByTime(0);

        // Turn off setting
        page.storageListener({ moeChatMediaAutoSelectEnabled: { newValue: false } }, 'sync');

        // Button enables after feature was disabled
        sendBtn.removeAttribute('disabled');
        await Promise.resolve();
        jest.runAllTimers();

        expect(page.sendCount).toBe(0);
        page.dom.window.close();
    });

    test('reconnects to an existing chat frame when Moe replaces its document after the launcher click', () => {
        jest.useFakeTimers();
        const dom = new JSDOM(`<!doctype html><html><body>
            <div id="ptb-header"><mo-icon name="digital"></mo-icon></div>
            <button id="launch-moe-btn" type="button">Connect with Moe</button>
            <iframe name="Messaging window"></iframe>
        </body></html>`, {
            url: 'https://groupmuk-prisma.mediaocean.com/campaign-management/#campaign-id=CP123',
            runScripts: 'outside-only'
        });
        const { window } = dom;
        const frame = window.document.querySelector('iframe');
        let activeDocument = null;
        Object.defineProperty(frame, 'contentDocument', {
            configurable: true,
            get: () => activeDocument
        });

        const chatDom = new JSDOM('<!doctype html><html><body></body></html>', {
            url: 'https://groupmuk-prisma.mediaocean.com/messaging',
            runScripts: 'outside-only'
        });
        const chatDocument = chatDom.window.document;
        chatDocument.body.innerHTML = `
            <div data-garden-id="containers.field">
                <label>Media</label>
                <input id="media-input" role="combobox" aria-label="Media" value="-">
            </div>
            <button id="send" type="button">Send</button>
        `;
        const input = chatDocument.getElementById('media-input');
        const sendButton = chatDocument.getElementById('send');
        let sendCount = 0;
        sendButton.addEventListener('click', () => { sendCount += 1; });
        input.addEventListener('click', () => {
            if (chatDocument.getElementById('media-listbox')) return;
            const listbox = chatDocument.createElement('ul');
            listbox.id = 'media-listbox';
            listbox.setAttribute('role', 'listbox');
            ['Digital', 'Print'].forEach(label => {
                const option = chatDocument.createElement('li');
                option.setAttribute('role', 'option');
                option.textContent = label;
                option.addEventListener('click', () => { input.value = label; });
                listbox.appendChild(option);
            });
            chatDocument.body.appendChild(listbox);
        });

        window.chrome = {
            storage: {
                sync: {
                    get: jest.fn((defaults, callback) => callback({ ...defaults, moeChatMediaAutoSelectEnabled: true }))
                }
            }
        };
        window.opsDiagnostics = { record: jest.fn() };
        window.eval(featureCode);
        window.moeChatMediaAutoSelectFeature.initialize();

        // The widget's iframe was already mounted, but its document was not
        // available when the feature first scanned the page.
        activeDocument = chatDocument;
        window.document.getElementById('launch-moe-btn').click();
        jest.runAllTimers();

        expect(input.value).toBe('Digital');
        expect(sendCount).toBe(1);
        chatDom.window.close();
        dom.window.close();
    });
});
