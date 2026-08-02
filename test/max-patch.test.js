import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const patchUrl = new URL('../ableton/iem-remote-bridge.maxpat', import.meta.url);

async function loadPatch() {
  return JSON.parse(await readFile(patchUrl, 'utf8')).patcher;
}

test('editable Max patch wires Node commands through the LiveAPI controller', async () => {
  const patcher = await loadPatch();
  const boxes = new Map(patcher.boxes.map(({ box }) => [box.id, box]));
  const connections = new Set(
    patcher.lines.map(({ patchline }) => (
      `${patchline.source[0]}:${patchline.source[1]}->${patchline.destination[0]}:${patchline.destination[1]}`
    )),
  );

  assert.equal(boxes.get('obj-node').text, 'node.script node-for-max-adapter.cjs @autostart 1');
  assert.equal(boxes.get('obj-route').text, 'route iem.command iem.adapter-status');
  assert.equal(boxes.get('obj-prepend').text, 'prepend iem.command');
  assert.equal(boxes.get('obj-controller').text, 'js live-api-controller.js');

  assert.ok(connections.has('obj-node:0->obj-route:0'));
  assert.ok(connections.has('obj-route:0->obj-command-tee:0'));
  assert.ok(connections.has('obj-command-tee:0->obj-prepend:0'));
  assert.ok(connections.has('obj-prepend:0->obj-controller:0'));
  assert.ok(connections.has('obj-controller:0->obj-event-tee:0'));
  assert.ok(connections.has('obj-event-tee:0->obj-node:0'));
});

test('editable Max patch requests a deferred rescan when the device becomes ready', async () => {
  const patcher = await loadPatch();
  const connections = new Set(
    patcher.lines.map(({ patchline }) => (
      `${patchline.source[0]}:${patchline.source[1]}->${patchline.destination[0]}:${patchline.destination[1]}`
    )),
  );

  assert.ok(connections.has('obj-thisdevice:0->obj-deferlow:0'));
  assert.ok(connections.has('obj-deferlow:0->obj-rescan:0'));
  assert.ok(connections.has('obj-rescan:0->obj-node:0'));
});
