use std::collections::HashMap;

use super::types::InputPhaseV3;

#[derive(Debug, Clone, Copy)]
pub struct PhaseOutputMac {
    pub stroke_id: u64,
    pub phase: InputPhaseV3,
    pub transition_error: bool,
}

#[derive(Debug, Clone, Copy)]
struct PointerState {
    in_contact: bool,
    stroke_id: u64,
}

#[derive(Debug, Default)]
pub struct PhaseMachineMac {
    next_stroke_id: u64,
    pointers: HashMap<u32, PointerState>,
}

impl PhaseMachineMac {
    pub fn new() -> Self {
        Self {
            next_stroke_id: 1,
            pointers: HashMap::new(),
        }
    }

    pub fn reset(&mut self) {
        self.next_stroke_id = 1;
        self.pointers.clear();
    }

    fn alloc_stroke_id(&mut self) -> u64 {
        let stroke_id = self.next_stroke_id;
        self.next_stroke_id = self.next_stroke_id.saturating_add(1);
        stroke_id
    }

    #[allow(clippy::too_many_arguments)]
    pub fn resolve(
        &mut self,
        pointer_id: u32,
        in_contact: bool,
        in_proximity: bool,
        explicit_down: bool,
        explicit_up: bool,
    ) -> Option<PhaseOutputMac> {
        if !self.pointers.contains_key(&pointer_id)
            && (in_contact || in_proximity || explicit_down || explicit_up)
        {
            let stroke_id = self.alloc_stroke_id();
            self.pointers.insert(
                pointer_id,
                PointerState {
                    in_contact: false,
                    stroke_id,
                },
            );
        }

        let mut state = *self.pointers.get(&pointer_id)?;
        if !in_proximity && !in_contact && !state.in_contact {
            self.pointers.remove(&pointer_id);
            return None;
        }

        let mut transition_error = false;
        let output = if explicit_up {
            transition_error = !state.in_contact;
            state.in_contact = false;
            let stroke_id = state.stroke_id;
            state.stroke_id = self.alloc_stroke_id();
            PhaseOutputMac {
                stroke_id,
                phase: InputPhaseV3::Up,
                transition_error,
            }
        } else if explicit_down {
            if state.in_contact {
                transition_error = true;
                PhaseOutputMac {
                    stroke_id: state.stroke_id,
                    phase: InputPhaseV3::Move,
                    transition_error,
                }
            } else {
                state.in_contact = true;
                PhaseOutputMac {
                    stroke_id: state.stroke_id,
                    phase: InputPhaseV3::Down,
                    transition_error,
                }
            }
        } else if in_contact {
            if state.in_contact {
                PhaseOutputMac {
                    stroke_id: state.stroke_id,
                    phase: InputPhaseV3::Move,
                    transition_error,
                }
            } else {
                state.in_contact = true;
                PhaseOutputMac {
                    stroke_id: state.stroke_id,
                    phase: InputPhaseV3::Down,
                    transition_error,
                }
            }
        } else if state.in_contact {
            state.in_contact = false;
            let stroke_id = state.stroke_id;
            state.stroke_id = self.alloc_stroke_id();
            PhaseOutputMac {
                stroke_id,
                phase: InputPhaseV3::Up,
                transition_error,
            }
        } else if in_proximity {
            PhaseOutputMac {
                stroke_id: state.stroke_id,
                phase: InputPhaseV3::Hover,
                transition_error,
            }
        } else {
            self.pointers.remove(&pointer_id);
            return None;
        };

        if !in_proximity && !state.in_contact {
            self.pointers.remove(&pointer_id);
        } else {
            self.pointers.insert(pointer_id, state);
        }
        Some(output)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn emits_hover_down_move_up_for_tablet_point_flow() {
        let mut machine = PhaseMachineMac::new();
        let hover = machine
            .resolve(11, false, true, false, false)
            .expect("hover");
        let down = machine.resolve(11, true, true, false, false).expect("down");
        let mv = machine.resolve(11, true, true, false, false).expect("move");
        let up = machine.resolve(11, false, true, false, false).expect("up");

        assert_eq!(hover.phase, InputPhaseV3::Hover);
        assert_eq!(down.phase, InputPhaseV3::Down);
        assert_eq!(mv.phase, InputPhaseV3::Move);
        assert_eq!(up.phase, InputPhaseV3::Up);
        assert_eq!(hover.stroke_id, down.stroke_id);
        assert_eq!(mv.stroke_id, down.stroke_id);
        assert_eq!(up.stroke_id, down.stroke_id);
    }

    #[test]
    fn explicit_down_and_up_are_single_edges() {
        let mut machine = PhaseMachineMac::new();
        let down = machine.resolve(3, true, true, true, false).expect("down");
        let second_down = machine
            .resolve(3, true, true, true, false)
            .expect("second down");
        let up = machine.resolve(3, false, true, false, true).expect("up");

        assert_eq!(down.phase, InputPhaseV3::Down);
        assert_eq!(second_down.phase, InputPhaseV3::Move);
        assert!(second_down.transition_error);
        assert_eq!(up.phase, InputPhaseV3::Up);
        assert_eq!(up.stroke_id, down.stroke_id);
    }

    #[test]
    fn emits_transition_error_for_up_without_contact() {
        let mut machine = PhaseMachineMac::new();
        let up = machine
            .resolve(9, false, true, false, true)
            .expect("up without prior down");
        assert_eq!(up.phase, InputPhaseV3::Up);
        assert!(up.transition_error);
    }
}
