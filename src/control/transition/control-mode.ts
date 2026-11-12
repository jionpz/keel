import type { ControlMode, ControlTransitionId } from '../../shared/ids.js'

export const CONTROL_ACTIONS = ['pause', 'resume', 'takeover'] as const
export type ControlAction = (typeof CONTROL_ACTIONS)[number]

export const CONTROL_TRANSITIONS: readonly {
  readonly id: ControlTransitionId
  readonly from: ControlMode
  readonly action: ControlAction
  readonly event: 'HumanPause' | 'HumanTakeover' | 'HumanResume' | 'HumanHandback'
  readonly to: ControlMode
}[] = [
  { id: 'C-001', from: 'auto', action: 'pause', event: 'HumanPause', to: 'paused' },
  { id: 'C-003', from: 'auto', action: 'takeover', event: 'HumanTakeover', to: 'human' },
  { id: 'C-004', from: 'paused', action: 'takeover', event: 'HumanTakeover', to: 'human' },
  { id: 'C-005', from: 'paused', action: 'resume', event: 'HumanResume', to: 'auto' },
  { id: 'C-006', from: 'human', action: 'resume', event: 'HumanHandback', to: 'auto' },
]

export function controlTransition(mode: ControlMode, action: ControlAction) {
  return CONTROL_TRANSITIONS.find((rule) => rule.from === mode && rule.action === action)
}
