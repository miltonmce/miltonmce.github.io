---
title: "Mapeo de Direcciones Modbus - PLC HNC Serie HCS"
description: "Guía definitiva de direccionamiento Modbus TCP confirmado mediante barridos técnicos para PLCs HNC serie HCS"
date: 2025-12-20
tags: ["Modbus", "PLC", "HNC", "Python", "Integración"]
---

# Mapeo de Direcciones Modbus - PLC HNC Serie HCS
**Modelo probado:** HCS-6X4Y-T  
**Configuración necesaria:** PLC en modo "Soft Address" (Mapeo por bloques de 1024/512)

Este repositorio contiene las direcciones Modbus TCP confirmadas mediante barridos técnicos (scanning). Es la guía definitiva para integrar PLCs HNC con Python, Django o SCADAs cuando la ficha técnica oficial no cuadra con la realidad del equipo

---

## 1. Tabla de Direccionamiento (Modbus Decimal)

Estas direcciones son las que responden tras el barrido. El PLC utiliza un **Offset de bloque**, ignorando el inicio en `0` que mencionan algunos manuales antiguos.

| Componente PLC | Dirección (DEC) | Tipo de Objeto Modbus | Función (FC) |
| :--- | :--- | :--- | :--- |
| **X (Entradas)** | **1024** | Discrete Input | **02** |
| **Y (Salidas)** | **1536** | Coil | 01, 05 |
| **M (Memorias)** | **3072** | Coil | 01, 05 |
| **V / D (Datos)** | **512** | Holding Register | 03, 06 |
| **CV (Contadores)**| **16384** | Input Register | **04** |

---

## 🔍 El caso extraño de los Contadores (CV)

Si revisas el manual, dice que los contadores pueden estar en varios lados, pero en el barrido técnico confirmamos lo siguiente para la serie HCS:

1. **Dirección Base:** Empiezan exactamente en la **16384** (que es la `0x4000` hexadecimal).
2. **Función de Lectura:** Se deben leer con la **función 04 (Input Registers)**. 
   * *Nota:* Si intentas leerlos con la función 03 y te da error o valores en cero, es porque el PLC protege estos acumuladores como "solo lectura" para evitar que el SCADA corrompa la cuenta del proceso.
3. **CV0 es la base:** Desde la 16384 en adelante encontrarás el valor en tiempo real (CV0, CV1, etc.).

**Tip PRO:** Si tu contador se mueve en el PLC pero en tu script el valor se queda fijo, asegúrate de estar usando `read_input_registers` y no `read_holding_registers`.

---

## 2. Detalles de Implementación

### Entradas y Salidas (X / Y)
* **X0...X5:** Mapeadas desde la **1024**. Úsalas para monitorear sensores o estados de campo. Son de solo lectura.
* **Y0...Y3:** Controladas desde la **1536**. Son las salidas físicas (relevador/transistor).

### Memorias Internas (M)
* **M0:** Arranca en la **3072**. Es la forma más eficiente de mandar banderas (flags) desde Python al programa Ladder.

### Manejo de 32 bits (Contadores de alta velocidad)
Para totalizadores grandes o contadores rápidos (rango CV48 - CV79), el PLC usa dos registros. Para reconstruir el valor en Python usa:  
`valor_total = (registro_alto << 16) | registro_bajo`

---

##  Direcciones Adicionales (Referencia de Manual)

Estas direcciones forman parte de la ficha técnica de la serie HCS, pero **no fueron verificadas** en el barrido técnico inicial. Si las utilizas, asegúrate de probar primero el offset (sumar +1024 o +1536) si la dirección base no te responde:

### Bits (Coils / Discrete)
| Componente | Dirección (DEC) | Tipo | Descripción |
| :--- | :--- | :--- | :--- |
| **T (Timers)** | 15360 | Coil | Estado del contacto del temporizador (ON/OFF). |
| **C (Counters)** | 16384 | Coil | Estado del contacto del contador (Llegada al Setpoint). |
| **SM (System)** | 16896 | Coil | Bits de estado del sistema (Relojes, flags de error). |
| **S (Step)** | 28672 | Coil | Relés de paso para programación secuencial (SFC). |

### Registros (Analógicas / Valores)
| Componente | Dirección (DEC) | Tipo | Descripción |
| :--- | :--- | :--- | :--- |
| **AI (Analog Input)** | 0 | Input Reg (04) | Entradas analógicas de módulos de expansión. |
| **AQ (Analog Output)**| 256 | Holding Reg (03) | Salidas analógicas de módulos de expansión. |
| **TV (Timer Value)** | 15360 | Holding Reg (03) | Valor actual del tiempo transcurrido en temporizadores. |
| **SV (System Reg)** | 17408 | Holding/Input | Registros de configuración interna del PLC. |



---

## Notas para el desarrollador

1. **Temporizadores (T vs TV):** Si quieres saber si el tiempo acabó, lee la Coil en **15360**. Si quieres saber cuánto tiempo lleva exactamente, lee el Holding Register en **15360**.
2. **Entradas Analógicas (AI):** A diferencia de las X/Y, las analógicas suelen mapearse en el bloque 0. Si no te responden ahí, intenta aplicar el mismo desplazamiento que usamos en las entradas digitales.
3. **Double Word:** Recuerda que para registros SV o valores de Timer de alta precisión, podrías necesitar leer dos registros consecutivos (32 bits).
---

## ¿Por qué las direcciones no coinciden con el manual oficial?

Si comparas este mapeo con la ficha técnica oficial de HNC, vas a notar que las direcciones están movidas (ej. el manual dice que **X0** está en `0`, pero aquí funciona en la `1024`). Esto no es un error, pasa por dos razones que confirmamos en las pruebas:

1. **Modo "Soft Address" (Mapeo por Bloques):** La serie HCS organiza la memoria por "cajones" segmentados para evitar que las direcciones se encimen. En lugar de amontonar todo desde la dirección 0, el firmware asigna un bloque de 512 o 1024 registros a cada tipo de dato. Es una medida de seguridad del fabricante para separar las entradas físicas de los registros internos del sistema.

2. **Protección de Datos (Input vs Holding):** El PLC separa lo que es "estado actual" (lectura pura) de lo que son "parámetros configurables". Por eso los contadores (**CV**) responden a la **Función 04 (Input Registers)**. Esto protege el acumulador para que un sistema externo (como un script o un SCADA) no pueda resetear o alterar el conteo accidentalmente sin una instrucción lógica escrita en el Ladder.

---

## Solución de Problemas (Troubleshooting)

* **¿Conexión rechazada?** Asegúrate de que no tengas abierto el software de programación (HCS Builder) conectado vía Ethernet al mismo tiempo, o que no haya otro script corriendo. El PLC tiene un límite de conexiones simultáneas.
* **¿Recibes puros ceros?** Revisa que el PLC esté en modo **RUN**. Si está en **STOP**, algunos registros de entradas y contadores dejan de actualizarse en la tabla Modbus.
* **¿Error de dirección ilegal?** Verifica el `device_id=1`. Si tu PLC tiene una ID distinta configurada en el System Block, no te va a responder aunque la IP sea la correcta.