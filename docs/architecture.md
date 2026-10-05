# xper core architecture

The Rust core resolves configuration and records execution facts reported by
adapters. It exposes terminal commands, an interactive dashboard, and a JSONL
bridge. Workflow decisions belong to the adapter: Rust has no knowledge-phase state machine, artifact
gates, execution-plan validator, or budget admission policy.

[RFC 0006](rfcs/0006-configuration-recording-and-adapter-workflows.md) explains
this boundary and the source-of-truth guarantees. The
[Pi guide](../adapters/pi/docs/architecture.md) describes the executable workflow.

Configuration preparation and recording delivery are background services to
Pi. Workflow start, execution, local status, and recovery do not await Rust.
The core may reject an invalid event or fail to respond without preventing Pi
from proceeding; its response determines delivery status only.

```mermaid
flowchart LR
    Adapter[Adapter workflow] --> Bridge[JSONL bridge]
    Terminal[CLI commands] --> Cases[Application operations]
    Dashboard[Terminal dashboard infrastructure] --> Cases
    Bridge --> Cases
    Cases --> Domain[Generic primitives]
    Cases --> Ports[Recording, configuration and installation ports]
    SQLite[SQLite] -. implements .-> Ports
    Local[Local configuration and installation] -. implements .-> Ports
    Bridge --> Config[Configuration resolution]
    Terminal --> Config
```

## Code navigation map

| Responsibility | Location | Contents |
| --- | --- | --- |
| Process entry point | `crates/xper-cli/src/main.rs` | Arguments and exit code |
| Bridge | `crates/xper-cli/src/bridge/` | Framing, handshake, sessions, RPC translation |
| CLI presentation | `crates/xper-cli/src/status.rs`, `setup.rs` | Text/JSON presentation |
| Terminal dashboard | `crates/xper-cli/src/infrastructure/tui/` | Ratatui views, input state, terminal lifecycle and background workers |
| Composition | `crates/xper-cli/src/composition.rs` | Concrete configuration and recording resources |
| Local adapters | `crates/xper-cli/src/infrastructure/` | Installation, scoped configuration files and active-profile selection |
| System operations | `crates/xper-application/src/use_cases/` | Append/query records, author configuration and coordinate setup |
| Dependencies | `crates/xper-application/src/ports.rs` | Recording and installation guarantees |
| Configuration authoring port | `crates/xper-application/src/configuration.rs` | Scope/document snapshots, edits, previews and repository guarantees |
| Event envelope | `crates/xper-application/src/events.rs` | Versioned reported event |
| Queryable state | `crates/xper-application/src/read_models/` | Generic projections and replay |
| Generic primitives | `crates/xper-domain/src/` | Identifiers and timestamps |
| Persistence | `crates/xper-store-sqlite/` | Atomic batches, deduplication, queries, and legacy inspection |
| Configuration | `crates/xper-config/` | Scope merge, profiles, context policy, model resolution and source-preserving edits |

## Public operations

| Entry point | Responsibility |
| --- | --- |
| Bare `xper` on an interactive terminal | Open configuration, recorded status and basic metrics in the dashboard |
| `configuration.resolve` | Resolve routing against an optional model catalog; return adapter configuration |
| `profile.inspect`, `xper profile` | Inspect a profile or resolve its routes; activation is a CLI operation |
| `event.append` | Record a batch of adapter-reported events |
| `run.status`, `xper status` | Read the recorded projection and timeline; the bridge also reports recording durability |
| `xper status --list` | Read a bounded page of recorded runs using a stable history cursor |
| `xper doctor` | Diagnose installation and configuration without modifying them |
| `xper init` | Run preflight and prepare configuration while preserving existing files |

`run.start`, `assignment.start`, `attempt.finish`, and `run.advance` are no
longer core operations. Their decisions are local Pi workflow operations.
Transport version 1 alone does not imply support for those old methods; see
the [public contract](../schemas/README.md) for capability negotiation.

Functions receive explicit dependencies. There is no global service container
or command bus. The interface handles RPC envelopes, terminal arguments, and
error presentation; application operations work with typed inputs and ports.
An event's arbitrary JSON `data` is a reported value, not an RPC request for
the application to execute.

## Terminal dashboard and configuration authoring

Views, terminal events, focus, navigation and draft state belong to CLI
infrastructure. Ratatui and Crossterm are dependencies of `xper-cli` only;
their types do not cross into configuration, application, domain, protocol or
storage crates. Composition starts the adapter, while its background workers
invoke the same application operations used by terminal commands. Opening the
dashboard reads existing state; it does not initialize configuration or create
an empty recording database.

`ConfigurationRepository` supplies inspect, preview, save and profile activation
operations with neutral values. Its snapshot contains the physical global,
project and local documents, authoring values merged through each scope, final
effective values, field origins, diagnostics and an opaque revision. A draft edits
one physical scope without inheriting higher-scope overrides. Preview validates the edited
scope with its inherited values and the final merged result; a higher scope
cannot hide an invalid new configuration. Model-catalog checks apply to affected
profiles when catalog information is available. Adapter configuration and unknown
role identifiers remain data, never Rust workflow policy.

`xper-config` parses and modifies the supported YAML subset. Scoped edits retain
unrelated fields and source outside changed nodes, including comments. Replacing
a node may format that subtree; JSON input remains supported. Unsupported YAML
features continue to fail, while quoted model identifiers and comment markers
are decoded correctly. The filesystem adapter writes a unique sibling temporary
file, preserves existing permissions, checks revisions across every scope and
activation immediately before replacement, and atomically renames the file.
Revision checks detect changes made since inspection; they are optimistic checks,
not locks respected by arbitrary external editors. Private local configuration is
added to `.gitignore`. A malformed document requires explicit replacement; errors
never echo credential values.

The YAML `profile` default and `.xper/active-profile` selection are distinct.
Activation takes precedence and can be cleared to return to the default.
Changing either applies to preparation for future runs; it does not modify a
running adapter's frozen selection. Initial dashboard setup uses installation
preflight before its first save. Editing existing configuration remains available
without Pi, and validation of the proposed document permits configuration repair.

The model picker consumes a separate, versioned adapter inspection contract;
it does not import a harness SDK into Rust. The Pi-owned helper describes role
metadata, loads model metadata, and performs Pi's native fuzzy search. The
dashboard manages that child process in a background worker with bounded I/O,
correlated requests and cancellation of obsolete searches. Provider allowlists
filter choices without managing authentication. The
[inspection contract](../adapters/pi/docs/inspection.md) documents its schema,
catalog lifecycle and Pi initialization behavior. This contract is independent
of Rust's configuration/recording JSON-RPC bridge and does not change protocol v1.

Status and metrics query the recorded projections through application use cases.
`RunReader::list_runs` exposes bounded pages ordered by run creation, with run IDs
as opaque continuation cursors; later observations do not reorder existing runs.
The dashboard renders existing metrics and their completeness/provenance without
interpreting Pi checkpoints or inferring workflow progress. Missing history and
unavailable catalogs leave navigation and other independent views usable.

## Recording guarantees

`RecordedEvent` carries `schemaVersion`, `eventId`, `runId`, `occurredAt`,
`type`, and an object-valued `data`. `occurredAt` is an integer timestamp in
milliseconds. The adapter supplies identities and reports facts; Rust does
not create an attempt or infer a successful outcome on its behalf.

Envelope identities and type names have bounded byte lengths. Generic summary
labels and outcome categories are also bounded so inspection can fit the
transport. Values that cannot be summarized remain intact in the raw events;
their projection is unknown rather than silently truncated. An unbound legacy
run has a null session owner.

`RunRepository::append_events` records one run's batch atomically for an
attached session. The envelope version, identifiers, and session ownership are
validated. Repeating an event with the same ID and identical content is safe;
conflicting reuse of an ID rejects the batch. These are recording-integrity
rules, independent of any workflow's permitted transitions.

Generic projections interpret common run, phase, attempt, and model-usage
observations. They accept arbitrary phase names and event kinds. An adapter
can report a phase revisit without Rust deciding whether it was appropriate.
Unknown types remain in the timeline. `adapter.state` is opaque checkpoint
data: only its owning adapter can decide whether and how to resume it.

The query reports the latest observed status and phase alongside basic counts
and reported usage. Metrics carry `formulaVersion`; absent usage fields stay
unknown. Pi reports observed provider/model identities and usage from completed
assistant messages. Its cost carries `costSource: "pi_estimate"`; it is not a
verified provider bill or Pi's budget reservation. `inputTokens` excludes
cached tokens; `cacheReadTokens` and `cacheWriteTokens` remain separate event
metadata and are not part of the current aggregate. Rich rework,
acceptance, comparison, and critical-path metrics remain in
[XP-013](tasks/013-metrics-inspection.md).

Projections can be rebuilt from the event log. Reopening or replaying records
does not manufacture an attempt failure, enforce a gate, or launch recovery
work. A missing completion is incomplete evidence. Pi owns execution recovery
and reports any subsequent outcome.

## Persistence and compatibility

SQLite is the normal durable local store. Opening it, fallback storage, and
connection lifetime belong to infrastructure and composition. Responses
expose whether recording is persistent or volatile; an acknowledgement from
volatile storage does not promise survival after process exit.

Pi's outbox delivers independently of execution, so this store can lag the
live workflow. Rust rejection cannot undo an observed action or authorize its
retry. Pi retains and exposes rejected events separately from deliverable
pending records. The local adapter checkpoint is sufficient for workflow
recovery; a remote history query is not a prerequisite.

The original workflow tables remain available for inspection. Legacy events
are exposed with a `legacy.` type prefix and their original JSON data; the
run is marked legacy. No Rust workflow state machine is needed to read them.
These records lack the new Pi checkpoint and cannot be resumed as a new Pi
workflow merely by inspecting them.

Configuration retains scope merging, credential rejection, provider allowlists,
and model/thinking compatibility checks. The existing `workflow.knowledge`
configuration is passed to Pi as opaque adapter configuration for compatibility.
Pi validates and applies its budgets and human gates. Core configuration must
not decide the next role or reinterpret those workflow settings.
Pi prepares resolved configuration asynchronously and freezes the latest
available snapshot, or visible defaults, at run start. Late configuration
responses do not mutate that active run.

## Extending the core

1. Identify a configuration, recording, or inspection need.
2. Add an operation with explicit inputs and dependencies where needed.
3. Preserve atomicity, duplicate consistency, ownership, and historical data.
4. Test the operation independently of Pi and model credentials.
5. Update the protocol, fixtures, and consumers when the public contract changes.

Add workflow rules to the adapter that owns them. Add generic metric formulas
only when the reported inputs and completeness semantics are defined. Future
UI changes must query facts and projections rather than reconstruct execution policy.

## Core verification

From the repository root:

```bash
npm run boundaries:core
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-targets
```

[check-core-boundaries.mjs](../scripts/check-core-boundaries.mjs) checks crate
dependencies, confines terminal libraries to CLI infrastructure, and protects the
configuration/recording boundary against workflow-policy modules. Static checks complement responsibility review;
they cannot establish the semantics of every event field.

Application tests use explicit dependencies, while SQLite and bridge tests
verify recording transactions, idempotent retries, projection rebuilding,
legacy inspection, and interface errors with temporary resources. The
[README](../README.md#development) describes aggregate verification.
