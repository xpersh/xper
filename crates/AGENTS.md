# Trabajo en el core Rust

Aplica junto al [AGENTS.md raíz](../AGENTS.md). Antes de modificar Rust, consulta
la [arquitectura del core](../docs/architecture.md), especialmente su mapa de
módulos y las garantías de los puertos.

## Dónde introducir el cambio

- `xper-domain`: entidades, invariantes y transiciones puras. No añadas
  dependencias externas, I/O ni conceptos de un harness.
- `xper-application/src/use_cases/`: una operación del sistema por módulo con
  `execute`, entradas y resultados explícitos. Coordina puertos; no recibe JSON,
  argumentos de terminal ni conexiones SQLite concretas.
- `xper-application/src/ports.rs`: necesidades de la aplicación y garantías de
  sus dependencias. El reloj y los IDs también se inyectan.
- `events.rs`, `read_models/` y `policies/`: hechos durables, replay y políticas
  de evidencia, respectivamente. Mantén estas responsabilidades separadas de
  la coordinación de los casos de uso.
- `xper-store-sqlite` y `xper-config`: implementaciones de persistencia y
  configuración. Conserva la atomicidad de los límites de workflow y la
  compatibilidad de los datos persistidos; añade migraciones cuando corresponda.
- `xper-cli`: traduce las entradas y presenta resultados. Los comandos y el
  bridge invocan casos de uso; no construyen eventos ni persisten transiciones.
  `composition.rs` conecta implementaciones concretas y `infrastructure/`
  contiene los adaptadores locales de puertos.
- `xper-protocol`: contrato neutral de transporte. Mantén sus cambios alineados
  con [schemas y consumidores](../schemas/README.md). `stdout` del bridge sólo
  admite frames JSONL; los diagnósticos van a `stderr`.

Para ampliar una vertical, expresa la regla de dominio, coordínala en un caso de
uso, prueba con dobles de sus puertos y conecta después el CLI o método RPC.
Comprueba qué piezas necesita realmente la operación antes de crear módulos.

El avance durable actual de Discovery se basa en proyecciones y eventos; todavía
no rehidrata la entidad `Run` del dominio. Ten en cuenta esta limitación al
ampliar las transiciones y evita duplicar sus reglas en otro lugar.

## Verificación

Desde la raíz, comprueba el área Rust con:

```bash
npm run boundaries:core
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-targets
```

Durante la iteración puedes limitar las pruebas con `cargo test -p <crate>`.
Los tests de aplicación usan puertos simulados y reloj/IDs deterministas; los
de infraestructura e interfaces verifican transacciones, recuperación y errores
con recursos temporales. Un cambio del bridge debe conservar también las pruebas
de sus consumidores. La comprobación final conjunta es `npm run check`.
