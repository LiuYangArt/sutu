use std::collections::HashMap;

use super::types::InputPhaseV3;

#[derive(Debug, Clone, Copy)]
pub struct PhaseOutput {
    pub stroke_id: u64,
    pub phase: InputPhaseV3,
}

#[derive(Debug, Clone, Copy)]
struct PointerState {
    in_contact: bool,
    stroke_id: u64,
}

#[derive(Debug, Default)]
pub struct PhaseMachine {
    next_stroke_id: u64,
    pointers: HashMap<u32, PointerState>,
}

impl PhaseMachine {
    pub fn new() -> Self {
        Self {
            next_stroke_id: 1,
            pointers: HashMap::new(),
        }
    }

    fn alloc_stroke_id(&mut self) -> u64 {
        let stroke_id = self.next_stroke_id;
        self.next_stroke_id = self.next_stroke_id.saturating_add(1);
        stroke_id
    }

    pub fn reset(&mut self) {
        self.next_stroke_id = 1;
        self.pointers.clear();
    }

    pub fn resolve(
        &mut self,
        pointer_id: u32,
        in_contact: bool,
        in_proximity: bool,
    ) -> Option<PhaseOutput> {
        if !self.pointers.contains_key(&pointer_id) && (in_contact || in_proximity) {
            let stroke_id = self.alloc_stroke_id();
            self.pointers.insert(
                pointer_id,
                PointerState {
                    in_contact: false,
                    stroke_id,
                },
            );
        }

        if !in_proximity && !in_contact {
            let state = *self.pointers.get(&pointer_id)?;
            if !state.in_contact {
                return None;
            }
            let next_stroke_id = self.alloc_stroke_id();
            self.pointers.insert(
                pointer_id,
                PointerState {
                    in_contact: false,
                    stroke_id: next_stroke_id,
                },
            );
            return Some(PhaseOutput {
                stroke_id: state.stroke_id,
                phase: InputPhaseV3::Up,
            });
        }

        let mut state = *self.pointers.get(&pointer_id)?;
        let output = if in_contact {
            if state.in_contact {
                PhaseOutput {
                    stroke_id: state.stroke_id,
                    phase: InputPhaseV3::Move,
                }
            } else {
                state.in_contact = true;
                PhaseOutput {
                    stroke_id: state.stroke_id,
                    phase: InputPhaseV3::Down,
                }
            }
        } else if state.in_contact {
            state.in_contact = false;
            let stroke_id = state.stroke_id;
            state.stroke_id = self.alloc_stroke_id();
            PhaseOutput {
                stroke_id,
                phase: InputPhaseV3::Up,
            }
        } else {
            PhaseOutput {
                stroke_id: state.stroke_id,
                phase: InputPhaseV3::Hover,
            }
        };

        self.pointers.insert(pointer_id, state);
        Some(output)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hover_down_move_up_sequence_keeps_single_stroke() {
        let mut machine = PhaseMachine::new();

        let hover = machine
            .resolve(1, false, true)
            .expect("hover should emit event");
        assert_eq!(hover.phase, InputPhaseV3::Hover);

        let down = machine
            .resolve(1, true, true)
            .expect("down should emit event");
        assert_eq!(down.phase, InputPhaseV3::Down);
        assert_eq!(down.stroke_id, hover.stroke_id);

        let mv = machine
            .resolve(1, true, true)
            .expect("move should emit event");
        assert_eq!(mv.phase, InputPhaseV3::Move);
        assert_eq!(mv.stroke_id, down.stroke_id);

        let up = machine
            .resolve(1, false, true)
            .expect("up should emit event");
        assert_eq!(up.phase, InputPhaseV3::Up);
        assert_eq!(up.stroke_id, down.stroke_id);
    }

    #[test]
    fn short_tap_emits_down_then_up() {
        let mut machine = PhaseMachine::new();

        let down = machine
            .resolve(8, true, true)
            .expect("down should emit event");
        let up = machine
            .resolve(8, false, true)
            .expect("up should emit event");

        assert_eq!(down.phase, InputPhaseV3::Down);
        assert_eq!(up.phase, InputPhaseV3::Up);
        assert_eq!(up.stroke_id, down.stroke_id);
    }

    #[test]
    fn dual_pointer_has_independent_strokes() {
        let mut machine = PhaseMachine::new();

        let p1_down = machine.resolve(1, true, true).expect("p1 down");
        let p2_down = machine.resolve(2, true, true).expect("p2 down");
        let p1_move = machine.resolve(1, true, true).expect("p1 move");
        let p2_up = machine.resolve(2, false, true).expect("p2 up");

        assert_eq!(p1_down.phase, InputPhaseV3::Down);
        assert_eq!(p2_down.phase, InputPhaseV3::Down);
        assert_ne!(p1_down.stroke_id, p2_down.stroke_id);
        assert_eq!(p1_move.stroke_id, p1_down.stroke_id);
        assert_eq!(p2_up.stroke_id, p2_down.stroke_id);
    }
}
