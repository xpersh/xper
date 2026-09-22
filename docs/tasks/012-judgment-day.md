# XP-012: Judgment Day, rework y cierre

- Estado: `pending`
- Milestone: M3
- Dependencias: XP-011

## Objetivo

Cerrar un run con una evaluación adversarial, reproducible y separada del
contexto de implementación.

## Alcance

- Construir el paquete mínimo de contexto para Judge.
- Ejecutar Judgment Day con modelo y contexto independientes cuando sea posible.
- Implementar todos los verdicts definidos en RFC 0001.
- Enrutar rework hacia Implementation, Design o Define.
- Solicitar decisión humana ante ambigüedad o acción irreversible.
- Generar retrospectiva y cerrar el run.

## Criterios de aceptación

- Cada criterio de aceptación enlaza evidencia concreta.
- Judge no hereda la conversación completa por defecto.
- `ACCEPT_WITH_DEBT` registra deuda, responsable lógico y condición futura.
- Los verdicts producen transiciones deterministas e idempotentes.
- Un run cerrado conserva snapshot, artefactos, métricas y retrospectiva.

## Fuera de alcance

- Despliegue o publicación automática a producción.
- Puntuar productividad humana.
