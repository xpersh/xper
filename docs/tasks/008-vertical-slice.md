# XP-008: Primera vertical slice de extremo a extremo

- Estado: `done`
- Milestone: M2
- Dependencias: XP-003, XP-004, XP-005, XP-006 y XP-007

## Objetivo

Demostrar la arquitectura completa con el flujo mínimo que aporta evidencia:
iniciar un run, delegar Discovery y avanzar a Define.

## Alcance

- Iniciar o reanudar un run desde una sesión Pi con `xper` activo.
- Crear un assignment `discovery.explorer`.
- Resolver y lanzar un subagente mediante el camino decidido en XP-001.
- Correlacionar lifecycle nativo con un Attempt de xper.
- Registrar un artefacto Discovery Brief mínimo.
- Evaluar el gate de Discovery y solicitar transición a Define.
- Mostrar estado desde `/xper status` y `xper status`.
- Persistir la secuencia completa en SQLite.

## Criterios de aceptación

- Existe un test end-to-end reproducible y una demo manual documentada.
- Éxito, fallo, cancelación y timeout terminan en estados distintos.
- Reiniciar el bridge permite recuperar el run.
- El core no contiene imports ni tipos de Pi.
- La transición no ocurre si falta la evidencia requerida.
- La timeline puede reconstruirse sólo desde eventos persistidos.

## Fuera de alcance

- Resto de fases y TUI avanzada.
- Routing adaptativo o comparación de perfiles.

## Implementación

- `/xper start <objetivo>` abre o reanuda el run asociado a esa sesión Pi y
  persiste `Intake -> Discovery` en una sola transacción. Cada sesión nueva puede
  iniciar un run independiente. En worktrees diferentes, cada sesión usa su
  propio `.xper/events.sqlite`; incluso si comparten directorio, sus runs no se
  mezclan.
- La tool propia `xper_delegate` crea un assignment `discovery.explorer` y un
  Attempt. El adaptador resuelve ese rol y lanza un Pi hijo por RPC. Correlaciona
  el `toolCallId` nativo con el `attemptId` de xper en las observaciones; no
  deriva el resultado de la tool `subagent` de `pi-open-agents`. El hijo se lanza
  sin sesión persistente ni extensión xper: el attempt pertenece al run del
  primary.
- El resultado final del hijo se escribe como Discovery Brief en
  `.xper/artifacts/`. El evento registra sólo su referencia. Éxito, fallo,
  cancelación y timeout se registran como resultados distintos; un crash deja
  `interrupted` tras expirar la lease del bridge (30 segundos más el siguiente
  ciclo de comprobación) y
  permite un nuevo attempt del mismo assignment con el parámetro `assignmentId`
  de `xper_delegate`.
- `run.advance` registra la evaluación del gate. Sólo entra a Define cuando
  existe un Brief no vacío vinculado a un attempt y assignment exitosos de la
  visita Discovery y todos los assignments de esa visita han terminado. Se
  pueden ejecutar varias llamadas a `xper_delegate` a la vez, cada una con su
  propio assignment y attempt. `/xper status` y `xper status --json` muestran la proyección
  y el CLI expone además la timeline de eventos persistidos.

SQLite serializa las escrituras breves de eventos, pero los bridges y los
subagentes pueden trabajar en paralelo. Cada bridge mantiene una lease renovada
periódicamente; abrir otra conexión no interrumpe sus attempts. Tras una caída,
un segundo bridge recupera los attempts cuando la lease caduca. Un cierre
normal del bridge libera la lease inmediatamente. Si `events.sqlite` está
bloqueado o contiene un historial incompatible, el bridge devuelve el error en
lugar de crear una base volátil separada.

La migración de esquema v3 elimina los vínculos adicionales creados con el
antiguo `join`: conserva la primera sesión asociada a cada run y no modifica
su historial de eventos. Las sesiones desvinculadas pueden iniciar un run
propio.

## Demo manual

Desde este checkout, con Pi y un proveedor/modelo configurados:

```bash
npm ci
npm run build --workspace @xper/adapter-pi
cargo build -p xper-cli
pi install -l npm:pi-open-agents@0.1.22
pi --approve --agent xper
```

En la sesión Pi:

```text
/xper start Explorar el estado de este proyecto
/xper advance
Usa xper_delegate para inspeccionar el proyecto y producir un Discovery Brief.
/xper status
```

La primera solicitud de avance debe devolver `advanced: false`. Tras el
resultado exitoso de `xper_delegate`, la tool solicita el avance y el estado
debe mostrar `phase define`. Fuera de Pi, desde el mismo directorio:

```bash
target/debug/xper status
target/debug/xper status --json
```

El JSON debe contener un `artifact_registered`, un `gate_evaluated` aprobado y
un `phase_entered` de Define. Reiniciar Pi o ejecutar `/reload` y consultar
`/xper status` debe conservar el mismo run. La timeline sólo contiene IDs,
estados y la ruta del Brief; el texto del task y la salida del hijo no se
guardan en SQLite.

Dos sesiones Pi, preferiblemente en worktrees distintos, crean runs aislados al
ejecutar `/xper start <objetivo>`. Dentro de un run, varias llamadas a
`xper_delegate` pueden ejecutarse a la vez; el gate espera al último assignment
pendiente antes de pasar a Define. Desde cada worktree,
`xper status --run <runId> --json` permite inspeccionar un run concreto.

## Verificación reproducible

```bash
npm run check
```

El test end-to-end en `adapters/pi/src/extension.test.ts` usa un Pi hijo RPC
determinista sin credenciales para cubrir los cuatro resultados, el gate sin
evidencia, la recuperación tras reinicio y el CLI. Otro test mata el bridge
durante un attempt, adelanta la caducidad de su lease y verifica su estado
`interrupted` y el retry. Una prueba adicional abre dos bridges sobre el mismo
SQLite, comprueba runs separados por sesión y delegaciones simultáneas dentro
de uno de ellos. Los tests de `xper-store-sqlite` reconstruyen proyecciones
desde el log y comprueban el append transaccional.
