pub mod coordinate_mapper;
pub mod coordinate_mapper_mac;
pub mod macnative_adapter;
pub mod phase_machine;
pub mod phase_machine_mac;
pub mod timebase;
pub mod timebase_mac;
pub mod types;
#[cfg(target_os = "windows")]
pub mod wintab_adapter;

pub use coordinate_mapper::CoordinateMapper;
pub use coordinate_mapper_mac::{CoordinateMapperMac, MappedCoordinateMac};
pub use macnative_adapter::{MacNativeAdapterV3, MacNativeEventKind, MacNativeRawSample};
pub use phase_machine::{PhaseMachine, PhaseOutput};
pub use phase_machine_mac::PhaseOutputMac;
pub use timebase::MonotonicTimebase;
pub use timebase_mac::MonotonicTimebaseMac;
pub use types::{InputPhaseV3, InputSourceV3, NativeTabletEventV3};
#[cfg(target_os = "windows")]
pub use wintab_adapter::WinTabAdapter;
