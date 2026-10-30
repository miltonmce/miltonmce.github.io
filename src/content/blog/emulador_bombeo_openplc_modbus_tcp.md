---
title: "Estación de bombeo simulada con OpenPLC y Modbus TCP"
description: "Banco de pruebas en Structured Text sobre OpenPLC Runtime v4, comandado desde Python con pymodbus: enclavamientos, fallos y totalizador de volumen."
date: 2026-10-29
tags: ["OpenPLC", "Modbus", "PLC", "Python", "Structured Text"]
---

# Estación de bombeo simulada con OpenPLC y Modbus TCP

Cuando se desarrolla una HMI, un SCADA o un script de integración, conseguir un PLC
físico para probar suele ser el primer cuello de botella. En esta entrada presento
**[openplc-modbus-tcp](https://github.com/miltonmce/openplc-modbus-tcp)**, un proyecto
que simula una estación de bombeo en **Structured Text (IEC 61131-3)** y la expone
por **Modbus TCP**, de forma que cualquier cliente puede comandarla y leer su estado
en tiempo real sin necesidad de hardware.

La diferencia con un *stub* es importante: el PLC ejecuta lógica de control real
—enclavamientos, prioridades de seguridad, códigos de fallo, rampa de caudal y
totalizador de volumen— y no se limita a devolver valores fijos.

---

## 1. Qué hace el programa

- **Marcha/paro con enclavamiento**: arranque por flanco de subida y paro por nivel.
- **Prioridades de seguridad**: emergencia y falta de agua paran la bomba y enclavan
  un fallo, aunque exista orden de marcha.
- **Códigos de fallo persistentes**: `101` emergencia, `102` marcha en seco y `103`
  sin agua. Solo se rearman si la condición es segura y la bomba está parada.
- **Simulación del caudal**: rampa de 2 L/min por ciclo hasta el punto de consigna
  (120 L/min), con ruido senoidal determinista de ±4 % y decaimiento inercial al parar.
- **Marcha en seco**: si el caudal no llega a 5 L/min tras 3 s de marcha, se dispara
  el fallo `102` a los 5 s.
- **Totalizador de volumen**: integra el caudal en cada scan de 20 ms.

---

## 2. Arquitectura

```
        Modbus TCP (:5020)                    OpenPLC Runtime v4
  ┌────────────────────────┐          ┌──────────────────────────────┐
  │ HMI / SCADA / pymodbus │ ───────► │  %MW0  palabra de mando      │
  │                        │          │  %MD0  caudal      (REAL)    │
  │                        │ ◄─────── │  %MD1  volumen     (REAL)    │
  └────────────────────────┘          │  %QX0.0/0.1  estado          │
                                      └──────────────┬───────────────┘
                                                     │ task0, T#20ms
                                                     ▼
                                      ┌──────────────────────────────┐
                                      │ main.st  (Structured Text)   │
                                      └──────────────────────────────┘
```

El POU se compila con STruC++ y se ejecuta en el **runtime v4** dentro de un
contenedor. La imagen Modbus se declara con variables localizadas (`AT %MW0`,
`AT %MD0`, `AT %QX0.0`), de modo que el cliente ve directamente el estado del
programa sin capas intermedias.

La estructura del repositorio es deliberadamente pequeña:

```
pous/programs/main.st           lógica del proceso (Structured Text)
devices/servers/modbus-tcp.json servidor Modbus TCP y segmentación de buffers
tools/modbus_check.py           cliente pymodbus + secuencia de aceptación
MODBUS.md                       mapa de direcciones y puesta en marcha
project.json                    tarea cíclica (T#20ms) e instancias del programa
```

---

## 3. Lógica del proceso en Structured Text

El programa tiene una única tarea cíclica `task0` de **20 ms**. Ese periodo es parte
del contrato: el totalizador lo usa como `Δt`, así que si se cambia el intervalo de
la tarea hay que actualizar la constante `Cycle_Time_s` en la lógica.

El control de la bomba combina un arranque por flanco con paros por nivel:

```iecst
IF Emergency_Stop OR NOT Water_Level_OK OR Stop_Button THEN
  Pump_Cmd := FALSE;
ELSIF Start_Button AND NOT Start_Prev AND NOT Fault_Active THEN
  Pump_Cmd := TRUE;
END_IF;

Start_Prev := Start_Button;
```

Los fallos se enclavan y solo se limpian cuando la condición es segura:

```iecst
IF Emergency_Stop THEN
  Fault_Active := TRUE;
  Fault_Code   := 101;
ELSIF NOT Water_Level_OK THEN
  Fault_Active := TRUE;
  Fault_Code   := 103;
END_IF;

IF Reset_Fault AND NOT Emergency_Stop AND Water_Level_OK AND NOT Pump_Cmd THEN
  Fault_Active := FALSE;
  Fault_Code   := 0;
END_IF;
```

El totalizador integra el caudal en cada scan:

```iecst
Volume_Liters := Volume_Liters + (Flow_Rate_Lpm * (Cycle_Time_s / 60.0));
```

| Fallo | Código | Causa |
| :--- | :--- | :--- |
| Emergencia | `101` | Seta de emergencia activada |
| Marcha en seco | `102` | Caudal < 5 L/min tras 3 s de marcha, dispara a los 5 s |
| Sin agua | `103` | Nivel de aspiración incorrecto |

---

## 4. Imagen Modbus: variables localizadas

En lugar de mantener una tabla de registros paralela a la lógica, `main.st` declara
la imagen Modbus directamente:

```iecst
Modbus_Cmd        AT %MW0 : INT;
Modbus_Fault_Code AT %MW1 : INT;
Modbus_Flow       AT %MD0 : REAL;
Modbus_Volume     AT %MD1 : REAL;
Modbus_Pump       AT %QX0.0 : BOOL;
Modbus_Fault      AT %QX0.1 : BOOL;
```

El programa decodifica los comandos al inicio del scan y publica el estado al final,
de forma que el cliente siempre lee un ciclo coherente.

### Coils — FC 01 (leer) / FC 05 (escribir)

| Dirección | Variable IEC | Tipo | Descripción |
| :--- | :--- | :--- | :--- |
| 0 | `%QX0.0` · `Modbus_Pump` | BOOL | Bomba en marcha |
| 1 | `%QX0.1` · `Modbus_Fault` | BOOL | Fallo enclavado activo |

### Holding registers — FC 03 (leer) / FC 06 (escribir)

| Rango | Variable IEC | Tipo | Descripción |
| :--- | :--- | :--- | :--- |
| 0–1023 | `%QW0`–`%QW1023` | INT | Palabras de salida (sin uso) |
| **1024** | `%MW0` · `Modbus_Cmd` | INT | **Palabra de mando (escritura)** |
| **1025** | `%MW1` · `Modbus_Fault_Code` | INT | **Código de fallo** |
| 1026–2047 | `%MW2`–`%MW1023` | INT | Libres |
| **2048–2049** | `%MD0` · `Modbus_Flow` | REAL | **Caudal [L/min]** (float32) |
| **2050–2051** | `%MD1` · `Modbus_Volume` | REAL | **Volumen total [L]** (float32) |
| 2052–4095 | `%MD2`–`%MD1023` | DINT | Libres |

Las funciones `02` y `04` existen pero están vacías: un maestro Modbus no puede
escribir entradas discretas, y el editor rechaza variables `%IX` localizadas sin un
productor. Por eso todos los comandos entran por coils o holding registers.

### Bits de la palabra de mando (`%MW0`, registro 1024)

| Bit | Máscara | Señal | Comportamiento |
| :--- | :--- | :--- | :--- |
| b0 | `0x01` | Marcha | Flanco de subida; enclava la marcha |
| b1 | `0x02` | Paro | Nivel; a 1 detiene la bomba |
| b2 | `0x04` | Emergencia | Nivel; a 1 enclava el fallo `101` |
| b3 | `0x08` | Sin agua (negado) | 1 = falta de agua → fallo `103`; 0 = nivel correcto |
| b4 | `0x10` | Rearme | Limpia el fallo si la condición es segura |
| b5 | `0x20` | Reset de volumen | Pone el totalizador a cero |

El registro se escribe completo con FC 06, así que cada escritura sustituye el
estado anterior: para "soltar" un pulsador hay que reescribir el registro con el bit
a 0. El bit `b3` está negado a propósito, para que una palabra de mando a cero sea el
estado sano por defecto si el cliente nunca llega a escribir.

---

## 5. Puesta en marcha

Requisitos: OpenPLC Editor v4, podman o docker, Python 3.10+ y las dependencias de
`requirements.txt`.

```sh
# 1. Runtime
podman pull ghcr.io/autonomy-logic/openplc-runtime:latest
podman run -d --name openplc-runtime --network host \
  --cap-add=SYS_NICE --cap-add=SYS_RESOURCE \
  -v openplc-runtime-data:/var/run/runtime \
  ghcr.io/autonomy-logic/openplc-runtime:latest

# 2. Usuario del runtime (solo la primera vez)
curl -k -X POST https://127.0.0.1:8443/api/create-user \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"TU_PASSWORD","role":"admin"}'

# 3. Compilar, subir y arrancar el PLC
openplc-editor.AppImage --ozone-platform=headless --disable-gpu \
  --cli upload . --target 'OpenPLC Runtime v4' \
  --host 127.0.0.1 --credentials admin:TU_PASSWORD --yes --json

# 4. Cliente de pruebas
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
python3 tools/modbus_check.py --demo
```

El servidor escucha en **5020** y no en 502 porque este último es privilegiado y
podman sin root no puede enlazarlo. Para usar el puerto estándar:

```sh
sudo sysctl -w net.ipv4.ip_unprivileged_port_start=502
```

Después hay que cambiar `"port": 5020` → `502` en
`devices/servers/modbus-tcp.json`, recompilar y volver a subir el programa.

---

## 6. Cliente de pruebas con pymodbus

El cliente `tools/modbus_check.py` encapsula el mapa de direcciones y expone las
operaciones básicas. Un detalle importante es que los pulsadores se manejan con un
pulso: se escribe el bit, se espera al menos un scan y se vuelve a escribir cero.

```python
from pymodbus.client import ModbusTcpClient

REG_CMD = 1024
CMD_START = 0x01

client = ModbusTcpClient("127.0.0.1", port=5020)
client.connect()

client.write_register(REG_CMD, CMD_START, device_id=1)
time.sleep(0.3)
client.write_register(REG_CMD, 0, device_id=1)
```

El paro, en cambio, es por nivel: se deja el bit `b1` activo el tiempo suficiente y
luego se limpia. La lectura del estado combina coils y holding registers:

```python
coils = client.read_coils(0, count=2, device_id=1).bits[:2]
flow = client.read_holding_registers(2048, count=2, device_id=1).registers
volume = client.read_holding_registers(2050, count=2, device_id=1).registers
```

Los `REAL` ocupan dos registros de 16 bits. El servidor está configurado con
`word_order = high_word_first`, así que la decodificación en Python es directa:

```python
import struct

def to_float(regs):
    """Dos registros Modbus (palabra alta primero) -> float32."""
    return struct.unpack(">f", struct.pack(">HH", regs[0], regs[1]))[0]
```

Para un vistazo rápido del estado hay un modo de muestreo continuo:

```sh
python3 tools/modbus_check.py --watch 1
```

Y para comandarlo desde la terminal:

```sh
python3 tools/modbus_check.py --start
python3 tools/modbus_check.py --stop
python3 tools/modbus_check.py --water-low     # simula falta de agua
python3 tools/modbus_check.py --reset-fault
python3 tools/modbus_check.py --reset-volume
```

---

## 7. Prueba de aceptación

El modo `--demo` ejecuta una secuencia completa y valida las invariantes del proceso:

```
reposo         bomba=OFF  caudal=    0.00 L/min  volumen=     0.00 L  fallo=no
marcha 0.5s    bomba=ON   caudal=   80.00 L/min  volumen=     0.55 L  fallo=no
marcha 3.5s    bomba=ON   caudal=  121.94 L/min  volumen=     6.42 L  fallo=no
tras 2s        bomba=ON   caudal=  124.31 L/min  Δvol=4.00 L → 2.00 L/s
sin agua       bomba=OFF  fallo=sí [103: sin agua]
rearme         fallo=no   [0]
reset vol.     volumen=  0.00 L
OK: todas las comprobaciones pasaron
```

La secuencia comprueba que la bomba arranca, que el caudal totalizado ronda los
2 L/s, que la falta de agua enclava el fallo `103`, que el rearme deja el PLC limpio
y que el reset de volumen devuelve el totalizador a cero. Es una prueba de
aceptación útil como plantilla para integraciones propias.

---

## 8. Trampas encontradas durante el desarrollo

- **`REAL`, no `LREAL`**: en el target AVR del simulador, `double` ocupa 4 bytes pero
  el mapa de depuración lo declara como 8, lo que desplaza todas las variables
  posteriores y muestra basura en el watch. `REAL` se mapea a 4 bytes y decodifica bien.
- **Comandos por `%MW`, no por `%IX`**: un maestro Modbus no puede escribir entradas
  discretas, y el editor rechaza variables `%IX` localizadas sin un productor.
- **Puerto 5020 en lugar de 502**: evita el problema de puerto privilegiado con podman
  sin root; `MODBUS.md` explica cómo moverlo al puerto estándar.
- **El target `OpenPLC Simulator` no sirve para esto**: descarta la configuración del
  servidor Modbus y solo habla RTU sobre un puerto serie virtual en proceso. Modbus TCP
  necesita el target `OpenPLC Runtime v4`.
- **El registro de mando se escribe completo (FC 06)**: no existe escritura de bits
  individuales sobre `%MW0`, así que cada comando debe reescribir la palabra entera.

---

## 9. Conclusión

Un PLC simulado con lógica real es una herramienta muy práctica: permite desarrollar
y probar clientes Modbus, HMIs y automatizaciones antes de tener el equipo físico, y
sirve como documentación ejecutable del proceso.

El proyecto está disponible en
**[github.com/miltonmce/openplc-modbus-tcp](https://github.com/miltonmce/openplc-modbus-tcp)**
bajo licencia MIT. Si trabajas con OpenPLC o Modbus y quieres adaptar el proceso
—otro tipo de bomba, más fallos, un lazo PID— la lógica está concentrada en un único
POU y el mapa de direcciones en un solo archivo de configuración.
