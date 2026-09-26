# Trabajo en el adaptador Pi

Aplica junto al [AGENTS.md raíz](../../AGENTS.md). Lee primero la
[arquitectura del adaptador](docs/architecture.md), incluido su diagrama. Estas
reglas también orientan los cambios en la integración `.pi/` del checkout.

## Dónde introducir el cambio

- `src/extension.ts` compone dependencias y registra la extensión.
- `src/pi/` traduce comandos, tools y hooks de Pi, presenta resultados y
  gestiona la sesión y las observaciones.
- `src/actions/` coordina una acción de integración con dependencias inyectadas.
  No importa APIs de Pi, procesos, archivos ni implementaciones concretas del
  bridge. Prueba la acción con dobles antes de conectarla a su entrada.
- `src/bridge/xper-client.ts` ofrece las operaciones tipadas del workflow y
  valida sus respuestas. Añade aquí las operaciones públicas nuevas que
  necesite el adaptador; no hagas llamadas RPC de workflow desde otros módulos.
- `src/bridge/client.ts` se ocupa del transporte, correlación y handshake;
  `src/bridge/protocol.ts`, de envelopes y errores del contrato.
- `src/discovery/` implementa la ejecución de Pi y la escritura del Brief.
  Mantén estos efectos fuera de la acción que los coordina.

Los gates y las transiciones los decide el core. No importes internals de los
crates ni reconstruyas reglas del dominio en TypeScript. Una observación de Pi
no sustituye al resultado registrado de un attempt.

Conserva la diferencia entre éxito, fallo, cancelación y timeout. Publica la ruta
de un artefacto sólo después de guardarlo y no sobrescribas evidencia existente.
Si una mutación falla por transporte, no inventes otro resultado ni la reintentes
sin conocer si el core la ha confirmado.

## Verificación

Desde la raíz:

```bash
npm run boundaries --workspace @xper/adapter-pi
npm run typecheck --workspace @xper/adapter-pi
npm run test --workspace @xper/adapter-pi
```

El comando de tests compila el paquete. Las pruebas de acciones y cliente usan
dobles; las de artefactos usan directorios temporales. Las de integración
necesitan el checkout y el toolchain Rust, arrancan el bridge y simulan el proceso
Pi, sin credenciales de modelos. Conserva esta separación al añadir pruebas.

No edites `dist/`. Para comprobar la integración manual, usa las instrucciones
del [README](../../README.md#relación-con-pi); una demo no sustituye a los tests.
Antes de entregar cambios de código, ejecuta también `npm run check`.
