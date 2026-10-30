---
title: "Simulated Pump Station with OpenPLC and Modbus TCP"
description: "A Structured Text test bench on OpenPLC Runtime v4, driven from Python with pymodbus: interlocks, fault codes and a volume totalizer."
date: 2026-10-29
tags: ["OpenPLC", "Modbus", "PLC", "Python", "Structured Text"]
lang: en
---

# Simulated Pump Station with OpenPLC and Modbus TCP

When you are building an HMI, a SCADA system or an integration script, getting a real
PLC just to test against is usually the first bottleneck. This post introduces
**[openplc-modbus-tcp](https://github.com/miltonmce/openplc-modbus-tcp)**, a project
that simulates a pump station in **Structured Text (IEC 61131-3)** and exposes it over
**Modbus TCP**, so any client can command it and read its state in real time without
any hardware.

The difference from a stub matters: the PLC runs real control logic —interlocks,
safety priorities, fault codes, a flow ramp and a volume totalizer— instead of
returning fixed values.

---

## 1. What the program does

- **Latched start/stop**: start on a rising edge, stop on level.
- **Safety priorities**: emergency stop and low water stop the pump and latch a fault,
  even if a start command is present.
- **Persistent fault codes**: `101` emergency stop, `102` dry run and `103` low water.
  They only clear when the condition is safe and the pump is stopped.
- **Flow simulation**: a 2 L/min ramp per cycle up to the setpoint (120 L/min), with
  deterministic ±4 % sine noise and inertial decay on stop.
- **Dry run detection**: if flow does not reach 5 L/min after 3 s of running, fault
  `102` trips at 5 s.
- **Volume totalizer**: integrates flow on every 20 ms scan.

---

## 2. Architecture

```
        Modbus TCP (:5020)                    OpenPLC Runtime v4
  ┌────────────────────────┐          ┌──────────────────────────────┐
  │ HMI / SCADA / pymodbus │ ───────► │  %MW0  command word          │
  │                        │          │  %MD0  flow     (REAL)       │
  │                        │ ◄─────── │  %MD1  volume   (REAL)       │
  └────────────────────────┘          │  %QX0.0/0.1  status          │
                                      └──────────────┬───────────────┘
                                                     │ task0, T#20ms
                                                     ▼
                                      ┌──────────────────────────────┐
                                      │ main.st  (Structured Text)   │
                                      └──────────────────────────────┘
```

The POU is compiled with STruC++ and runs on the **v4 runtime** inside a container.
The Modbus image is declared with located variables (`AT %MW0`, `AT %MD0`,
`AT %QX0.0`), so the client sees the program state directly, with no intermediate
layers.

The repository layout is intentionally small:

```
pous/programs/main.st           process logic (Structured Text)
devices/servers/modbus-tcp.json Modbus TCP server and buffer segmentation
tools/modbus_check.py           pymodbus client + acceptance sequence
MODBUS.md                       address map and commissioning notes
project.json                    cyclic task (T#20ms) and program instances
```

---

## 3. Process logic in Structured Text

The program has a single cyclic task, `task0`, running every **20 ms**. That period is
part of the contract: the totalizer uses it as `Δt`, so changing the task interval
requires updating the `Cycle_Time_s` constant in the logic.

Pump control combines a rising-edge start with level-triggered stops:

```iecst
IF Emergency_Stop OR NOT Water_Level_OK OR Stop_Button THEN
  Pump_Cmd := FALSE;
ELSIF Start_Button AND NOT Start_Prev AND NOT Fault_Active THEN
  Pump_Cmd := TRUE;
END_IF;

Start_Prev := Start_Button;
```

Faults latch and only clear when the condition is safe:

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

The totalizer integrates flow on every scan:

```iecst
Volume_Liters := Volume_Liters + (Flow_Rate_Lpm * (Cycle_Time_s / 60.0));
```

| Fault | Code | Cause |
| :--- | :--- | :--- |
| Emergency stop | `101` | Emergency stop button active |
| Dry run | `102` | Flow < 5 L/min after 3 s of running, trips at 5 s |
| Low water | `103` | Suction level is not correct |

---

## 4. Modbus image: located variables

Instead of maintaining a register table parallel to the logic, `main.st` declares the
Modbus image directly:

```iecst
Modbus_Cmd        AT %MW0 : INT;
Modbus_Fault_Code AT %MW1 : INT;
Modbus_Flow       AT %MD0 : REAL;
Modbus_Volume     AT %MD1 : REAL;
Modbus_Pump       AT %QX0.0 : BOOL;
Modbus_Fault      AT %QX0.1 : BOOL;
```

The program decodes commands at the start of the scan and publishes status at the
end, so the client always reads a coherent cycle.

### Coils — FC 01 (read) / FC 05 (write)

| Address | IEC variable | Type | Description |
| :--- | :--- | :--- | :--- |
| 0 | `%QX0.0` · `Modbus_Pump` | BOOL | Pump running |
| 1 | `%QX0.1` · `Modbus_Fault` | BOOL | Latched fault active |

### Holding registers — FC 03 (read) / FC 06 (write)

| Range | IEC variable | Type | Description |
| :--- | :--- | :--- | :--- |
| 0–1023 | `%QW0`–`%QW1023` | INT | Output words (unused) |
| **1024** | `%MW0` · `Modbus_Cmd` | INT | **Command word (write)** |
| **1025** | `%MW1` · `Modbus_Fault_Code` | INT | **Fault code** |
| 1026–2047 | `%MW2`–`%MW1023` | INT | Free |
| **2048–2049** | `%MD0` · `Modbus_Flow` | REAL | **Flow [L/min]** (float32) |
| **2050–2051** | `%MD1` · `Modbus_Volume` | REAL | **Total volume [L]** (float32) |
| 2052–4095 | `%MD2`–`%MD1023` | DINT | Free |

Functions `02` and `04` exist but are empty: a Modbus master cannot write discrete
inputs, and the editor rejects located `%IX` variables without a producer. That is why
every command goes through coils or holding registers.

### Command word bits (`%MW0`, register 1024)

| Bit | Mask | Signal | Behaviour |
| :--- | :--- | :--- | :--- |
| b0 | `0x01` | Start | Rising edge; latches the pump on |
| b1 | `0x02` | Stop | Level; a 1 stops the pump |
| b2 | `0x04` | Emergency stop | Level; a 1 latches fault `101` |
| b3 | `0x08` | Low water (inverted) | 1 = low water → fault `103`; 0 = correct level |
| b4 | `0x10` | Reset fault | Clears the fault when it is safe |
| b5 | `0x20` | Reset volume | Sets the totalizer to zero |

The register is written whole with FC 06, so every write replaces the previous state:
releasing a pushbutton means rewriting the register with that bit at 0. Bit `b3` is
inverted on purpose, so an all-zero command word is the healthy default if the client
never writes.

---

## 5. Getting started

Requirements: OpenPLC Editor v4, podman or docker, Python 3.10+ and the dependencies
listed in `requirements.txt`.

```sh
# 1. Runtime
podman pull ghcr.io/autonomy-logic/openplc-runtime:latest
podman run -d --name openplc-runtime --network host \
  --cap-add=SYS_NICE --cap-add=SYS_RESOURCE \
  -v openplc-runtime-data:/var/run/runtime \
  ghcr.io/autonomy-logic/openplc-runtime:latest

# 2. Runtime user (first time only)
curl -k -X POST https://127.0.0.1:8443/api/create-user \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"YOUR_PASSWORD","role":"admin"}'

# 3. Compile, upload and start the PLC
openplc-editor.AppImage --ozone-platform=headless --disable-gpu \
  --cli upload . --target 'OpenPLC Runtime v4' \
  --host 127.0.0.1 --credentials admin:YOUR_PASSWORD --yes --json

# 4. Test client
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
python3 tools/modbus_check.py --demo
```

The server listens on **5020** rather than 502 because the latter is privileged and
rootless podman cannot bind it. To use the standard port:

```sh
sudo sysctl -w net.ipv4.ip_unprivileged_port_start=502
```

Then change `"port": 5020` → `502` in `devices/servers/modbus-tcp.json`, recompile and
upload again.

---

## 6. Test client with pymodbus

The `tools/modbus_check.py` client wraps the address map and exposes the basic
operations. One important detail is that pushbuttons are handled as pulses: write the
bit, wait for at least one scan and write zero again.

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

A stop is level-triggered instead: keep bit `b1` active long enough, then clear it.
Reading the status combines coils and holding registers:

```python
coils = client.read_coils(0, count=2, device_id=1).bits[:2]
flow = client.read_holding_registers(2048, count=2, device_id=1).registers
volume = client.read_holding_registers(2050, count=2, device_id=1).registers
```

`REAL` values occupy two 16-bit registers. The server is configured with
`word_order = high_word_first`, so decoding in Python is straightforward:

```python
import struct

def to_float(regs):
    """Two Modbus registers (high word first) -> float32."""
    return struct.unpack(">f", struct.pack(">HH", regs[0], regs[1]))[0]
```

For a quick status view there is a continuous sampling mode:

```sh
python3 tools/modbus_check.py --watch 1
```

And to command it from the terminal:

```sh
python3 tools/modbus_check.py --start
python3 tools/modbus_check.py --stop
python3 tools/modbus_check.py --water-low     # simulate low water
python3 tools/modbus_check.py --reset-fault
python3 tools/modbus_check.py --reset-volume
```

---

## 7. Acceptance test

The `--demo` mode runs a full sequence and checks the process invariants:

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

The sequence verifies that the pump starts, that totalized flow is around 2 L/s, that
low water latches fault `103`, that the reset leaves the PLC clean and that the volume
reset brings the totalizer back to zero. It works as a template for your own
integration tests.

---

## 8. Pitfalls found during development

- **`REAL`, not `LREAL`**: on the AVR simulator target, `double` takes 4 bytes but the
  debug map declares it as 8, shifting every later variable and showing garbage in the
  watch. `REAL` maps to 4 bytes and decodes correctly.
- **Commands through `%MW`, not `%IX`**: a Modbus master cannot write discrete inputs,
  and the editor rejects located `%IX` variables without a producer.
- **Port 5020 instead of 502**: avoids the privileged-port problem with rootless
  podman; `MODBUS.md` explains how to move to the standard port.
- **The `OpenPLC Simulator` target cannot do this**: it drops the Modbus server
  configuration and only speaks RTU over an in-process virtual serial port. Modbus TCP
  needs the `OpenPLC Runtime v4` target.
- **The command register is written whole (FC 06)**: there is no single-bit write on
  `%MW0`, so every command must rewrite the entire word.

---

## 9. Conclusion

A simulated PLC with real logic is a very practical tool: it lets you develop and test
Modbus clients, HMIs and automation before the physical equipment exists, and it works
as executable documentation of the process.

The project is available at
**[github.com/miltonmce/openplc-modbus-tcp](https://github.com/miltonmce/openplc-modbus-tcp)**
under the MIT license. If you work with OpenPLC or Modbus and want to adapt the process
—a different pump, more faults, a PID loop— the logic lives in a single POU and the
address map in a single configuration file.
