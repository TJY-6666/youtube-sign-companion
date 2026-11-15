import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from './vendor/three.module.js';
import { directionFrame, validateLandmarks, blendLandmarks, applyBodyLandmarks } from './landmarks.js';
const points = count => Array.from({ length: count }, (_, i) => [i / 30, 1, 0]);
const frame = () => ({ pose: points(6), left: points(21), right: null });
test('landmark tracks reject corrupt coordinates and unbounded clips', () => {
  const clip = { format: 'landmarks-v1', fps: 20, frames: [frame(), frame()] };
  assert.equal(validateLandmarks(clip), clip);
  clip.frames[0].left[2][0] = NaN;
  assert.throws(() => validateLandmarks(clip));
  clip.frames = Array.from({ length: 302 }, frame); assert.throws(() => validateLandmarks(clip));
});
test('palm frames have proper handedness and map the long axis without reflection', () => {
  assert.deepEqual(directionFrame(new T.Vector3(), new T.Vector3()).toArray(), [0, 0, 0, 1]);
  for (const along of [new T.Vector3(1, 2, 3), new T.Vector3(1, 0, 0), new T.Vector3(0, 0, -1)]) {
    const q = directionFrame(new T.Vector3(1, 0, 0), along);
    assert.ok(new T.Vector3(0, 1, 0).applyQuaternion(q).distanceTo(along.clone().normalize()) < 1e-7);
    assert.ok(Math.abs(new T.Matrix4().makeRotationFromQuaternion(q).determinant() - 1) < 1e-7);
  }
});
test('interpolation preserves tracking gaps and body directions drive connected arms', () => {
  const a = frame(), b = frame(); b.pose[0][0] = 2;
  assert.equal(blendLandmarks(a, b, .5).pose[0][0], 1);
  assert.equal(blendLandmarks(a, b, .5).right, null);
  const figure = new T.Group(), joints = new Map();
  for (const [name, side] of [['L', 1], ['R', -1]]) {
    const shoulder = new T.Group(), elbow = new T.Group(); elbow.position.x = side * .28; figure.add(shoulder); shoulder.add(elbow); joints.set(`${name}_Shoulder`, shoulder); joints.set(`${name}_Elbow`, elbow);
  }
  const pose = [[1, 1, 0], [-1, 1, 0], [1, 0, 0], [-1, 0, 0], [1, 0, 1], [-1, 0, 1]];
  applyBodyLandmarks(joints, { pose });
  for (const [name, side] of [['L', 1], ['R', -1]]) {
    assert.ok(new T.Vector3(side, 0, 0).applyQuaternion(joints.get(`${name}_Shoulder`).getWorldQuaternion(new T.Quaternion())).distanceTo(new T.Vector3(0, -1, 0)) < 1e-7);
    assert.ok(new T.Vector3(side, 0, 0).applyQuaternion(joints.get(`${name}_Elbow`).getWorldQuaternion(new T.Quaternion())).distanceTo(new T.Vector3(0, 0, 1)) < 1e-7);
  }
});
