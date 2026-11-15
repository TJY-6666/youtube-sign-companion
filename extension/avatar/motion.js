export const JOINTS = ['Neck', 'L_Collar', 'R_Collar', 'Head', 'L_Shoulder', 'R_Shoulder', 'L_Elbow', 'R_Elbow', 'L_Wrist', 'R_Wrist',
  ...['L', 'R'].flatMap(side => ['Index', 'Middle', 'Pinky', 'Ring', 'Thumb'].flatMap(finger => [1, 2, 3].map(n => `${side}_${finger}${n}`))), 'Jaw'];
// Front view: the signer's left is on the viewer's right (+X).
export const ARM_SIDES = [['L', 1], ['R', -1]];
export function sourceBodyAxis(frame, offset, target) {
  // The checked SMPL-X reference uses the same +X left, +Y up, +Z front basis.
  return target.set(frame[offset], frame[offset + 1], frame[offset + 2]);
}
export function validateMotion(clip) {
  if (clip?.poseProfile !== undefined && !['smplx-offsets', 'experimental-inverse'].includes(clip.poseProfile)) throw new Error('Unknown motion pose profile.');
  if (clip?.handPose !== undefined && clip.handPose !== 'smplx-absolute') throw new Error('Unknown hand pose convention.');
  if (clip?.format !== 'motion133' || clip.fps !== 20 || !Array.isArray(clip.frames) || clip.frames.length < 1 || clip.frames.length > 400 ||
      clip.frames.some(frame => !Array.isArray(frame) || frame.length !== 133 || frame.some(n => typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n) > 100))) {
    throw new Error('Invalid motion133 clip: expected 1–400 finite 133-value frames at 20 fps.');
  }
  return clip;
}
