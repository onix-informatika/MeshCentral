'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

// Exercise the actual agent and page handlers without requiring the native agent runtime.
function sourceFunction(source, name) {
    const start = new RegExp('^([ \\t]*)function ' + name + '\\(', 'm').exec(source);
    assert.ok(start, 'Missing function ' + name);
    const tail = source.slice(start.index);
    const end = new RegExp('\\n' + start[1] + '}(?=\\n|$)').exec(tail);
    assert.ok(end, 'Missing end of ' + name);
    return tail.slice(0, end.index + end[0].length);
}

const core = fs.readFileSync(path.join(__dirname, '../agents/meshcore.js'), 'utf8');
function agent(overrides = {}) {
    const packets = [], removed = [];
    const context = vm.createContext({
        Buffer, process: { platform: 'win32' }, obj: { path: path.posix },
        MeshServerLogEx() {},
        fs: { existsSync: () => true, unlinkSync: p => removed.push(p), ...overrides }
    });
    for (const name of ['sendFileUploadError', 'deleteFolderRecursive', 'onTunnelData']) {
        vm.runInContext(sourceFunction(core, name), context);
    }
    const tunnel = { httprequest: { state: 1, protocol: 5 }, write: p => packets.push(JSON.parse(p.toString())) };
    return { packets, removed, tunnel, send: command => context.onTunnelData.call(tunnel, typeof command === 'object' && !Buffer.isBuffer(command) ? JSON.stringify(command) : command) };
}

function page(template, rights = 0xFFFFFFFF) {
    const source = fs.readFileSync(path.join(__dirname, '../views/' + template + '.handlebars'), 'utf8');
    const dialogs = [], commands = [], refreshes = [];
    const context = vm.createContext({
        filesNode: { _id: 'node/test/device', name: 'Test device', agent: { id: 4 } },
        uploadFile: null, console, xxModal: null,
        showModal() {},
        GetNodeRights: () => rights,
        EscapeHtml: s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
        format: (s, value) => s.replace('{0}', value), decode_utf8: s => s,
        setSessionActivity() {},
        setDialogMode: (mode, title, buttons, callback, html, tag) => dialogs.push({ mode, title, buttons, callback, html, tag }),
        messagebox: (title, html) => dialogs.push({ title, html }),
        p13folderup: n => refreshes.push(n),
        files: { sendText: command => commands.push(JSON.parse(command)) },
        meshserver: { send: command => commands.push(JSON.parse(JSON.stringify(command))) }
    });
    for (const name of ['p13fileOperationError', 'p13restartAgentForFiles', 'p13restartAgentForFilesEx', 'p13gotFiles', 'p13gotUploadData', 'p13uploadFileCancel', 'p13uploadFileTransferDone']) {
        vm.runInContext(sourceFunction(source, name), context);
    }
    return { context, dialogs, commands, refreshes, receive: packet => context.p13gotFiles(JSON.stringify(packet)) };
}

function lockedError() { return Object.assign(new Error('The file is being used by another process.'), { code: 'EBUSY' }); }

test('delete reports every failed selection while preserving successful deletes', () => {
    const a = agent({ unlinkSync: p => { if (p.endsWith('ok.txt')) a.removed.push(p); else throw lockedError(); } });
    a.send({ action: 'rm', path: 'C:', reqid: 1, rec: false, delfiles: ['locked.zip', 'ok.txt', 'other.zip'] });
    assert.deepEqual(a.removed, ['C:/ok.txt']);
    assert.equal(a.packets.length, 1);
    assert.equal(a.packets[0].action, 'fileerror');
    assert.deepEqual(a.packets[0].errors.map(e => e.path), ['C:/locked.zip', 'C:/other.zip']);
});

test('recursive delete identifies the locked child, not just the selected folder', () => {
    const a = agent({ readdirSync: () => ['locked.dll'], statSync: () => ({ isDirectory: () => false }), unlinkSync: () => { throw lockedError(); } });
    a.send({ action: 'rm', path: 'C:', reqid: 1, rec: true, delfiles: ['deployment'] });
    assert.equal(a.packets[0].errors[0].path, 'C:/deployment/locked.dll');
});

test('successful delete produces no error packet', () => {
    const a = agent();
    a.send({ action: 'rm', path: 'C:', reqid: 1, delfiles: ['ok.txt'] });
    assert.deepEqual(a.removed, ['C:/ok.txt']);
    assert.deepEqual(a.packets, []);
});

test('upload-open error includes the active request, filename and native error', () => {
    const a = agent({ openSync: () => { throw lockedError(); } });
    a.send({ action: 'upload', path: 'C:', name: 'locked.zip', reqid: 7 });
    assert.deepEqual(a.packets, [{ action: 'uploaderror', reqid: 7, path: 'C:/locked.zip', error: 'The file is being used by another process.' }]);
});

for (const escaped of [false, true]) {
    test('upload-write error remains correlated with the active transfer, escaped=' + escaped, () => {
        const a = agent({ writeSync: () => { throw new Error('Disk full'); } });
        Object.assign(a.tunnel.httprequest, { uploadFile: 23, uploadFileid: 7, uploadFilePath: 'C:/upload.zip', uploadFileSize: 0 });
        a.send(Buffer.from(escaped ? [0, 123, 1] : [1, 2, 3]));
        assert.deepEqual(a.packets, [{ action: 'uploaderror', reqid: 7, path: 'C:/upload.zip', error: 'Disk full' }]);
    });
}

for (const template of ['default', 'default3', 'default-mobile']) {
    test(template + ': agent delete error reaches a visible escaped dialog', () => {
        const a = agent({ unlinkSync: () => { throw lockedError(); } });
        a.send({ action: 'rm', path: 'C:', reqid: 1, delfiles: ['<img onerror=bad>.zip'] });
        const p = page(template);
        p.receive(a.packets[0]);
        const dialog = p.dialogs.at(-1);
        assert.equal(dialog.title, 'Delete failed');
        assert.match(dialog.html, /C:\/&lt;img onerror=bad&gt;\.zip/);
        assert.doesNotMatch(dialog.html, /<img onerror/);
        assert.match(dialog.html, /Restart agent service/);
        assert.deepEqual(p.commands, []);
    });

    test(template + ': failed upload closes progress, cancels transfer and shows filename', () => {
        const p = page(template);
        p.context.uploadFile = { xfilePtr: 7, xpath: 'C:', xfiles: { 7: { name: 'locked.zip' } } };
        p.receive({ action: 'uploaderror', reqid: 7, error: 'File in use' });
        assert.equal(p.context.uploadFile, null);
        assert.deepEqual(p.commands, [{ action: 'uploadcancel', reqid: 7 }]);
        assert.equal(p.dialogs.at(-1).title, 'Upload failed');
        assert.match(p.dialogs.at(-1).html, /C:\/locked.zip/);
        assert.match(p.dialogs.at(-1).html, /File in use/);
        assert.equal(p.refreshes.length, 1);
    });

    test(template + ': legacy write errors without a request ID are visible', () => {
        const p = page(template);
        p.context.uploadFile = { xfilePtr: 0, xpath: 'C:', xfiles: [{ name: 'old-agent.zip' }] };
        p.receive({ action: 'uploaderror' });
        assert.equal(p.dialogs.at(-1).title, 'Upload failed');
        assert.match(p.dialogs.at(-1).html, /old-agent.zip/);
    });

    test(template + ': stale upload errors do not cancel a later file', () => {
        const p = page(template);
        p.context.uploadFile = { xfilePtr: 7 };
        p.receive({ action: 'uploaderror', reqid: 6 });
        assert.equal(p.context.uploadFile.xfilePtr, 7);
        assert.deepEqual(p.commands, []);
        assert.deepEqual(p.dialogs, []);
    });

    test(template + ': restart requires confirmation and targets the original device', () => {
        const p = page(template);
        p.context.p13restartAgentForFiles();
        const confirmation = p.dialogs.at(-1);
        assert.match(confirmation.html, /disconnects all remote sessions/);
        assert.match(confirmation.html, /Test device/);
        assert.deepEqual(p.commands, []);
        confirmation.callback(0, confirmation.tag);
        assert.deepEqual(p.commands, []);
        p.context.filesNode = { _id: 'node/test/other' };
        confirmation.callback(1, confirmation.tag);
        assert.deepEqual(p.commands, [{ action: 'msg', type: 'console', nodeid: 'node/test/device', value: 'service restart' }]);
        assert.match(p.dialogs.at(-1).html, /Restart requested/);
    });

    test(template + ': users without agent-console rights are not offered a restart', () => {
        const p = page(template, 8);
        p.receive({ action: 'fileerror', operation: 'rm', errors: [{ path: 'C:/locked.zip', error: 'File in use' }] });
        assert.doesNotMatch(p.dialogs.at(-1).html, /type=button/);
        const count = p.dialogs.length;
        p.context.p13restartAgentForFiles();
        assert.equal(p.dialogs.length, count);
        assert.deepEqual(p.commands, []);
    });
}

test('alternate desktop waits for the closing modal before displaying a fast error', () => {
    const p = page('default3');
    let hidden;
    p.context.xxModal = {};
    p.context.Q = () => ({ addEventListener: (event, callback, options) => {
        assert.equal(event, 'hidden.bs.modal');
        assert.equal(options.once, true);
        hidden = callback;
    } });
    p.context.hideModal = () => {};
    p.receive({ action: 'fileerror', operation: 'rm', errors: [{ path: 'C:/locked.zip', error: 'In use' }] });
    assert.deepEqual(p.dialogs, []);
    p.context.xxModal = null;
    hidden();
    assert.equal(p.dialogs.at(-1).title, 'Delete failed');
});
