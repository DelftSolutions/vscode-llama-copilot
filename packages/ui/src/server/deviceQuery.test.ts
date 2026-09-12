import { describe, it, expect } from 'vitest';
import { parseDeviceOutput } from './deviceQuery';

describe('parseDeviceOutput', () => {
	it('parses macOS Metal output', () => {
		const output = `ggml_metal_device_init: tensor API disabled for pre-M5 and pre-A19 devices
ggml_metal_library_init: using embedded metal library
ggml_metal_library_init: loaded in 6.241 sec
ggml_metal_rsets_init: creating a residency set collection (keep_alive = 180 s)
ggml_metal_device_init: GPU name:   MTL0
ggml_metal_device_init: GPU family: MTLGPUFamilyApple9  (1009)
ggml_metal_device_init: GPU family: MTLGPUFamilyCommon3 (3003)
ggml_metal_device_init: GPU family: MTLGPUFamilyMetal4  (5002)
ggml_metal_device_init: simdgroup reduction   = true
ggml_metal_device_init: simdgroup matrix mul. = true
ggml_metal_device_init: has unified memory    = true
ggml_metal_device_init: has bfloat            = true
ggml_metal_device_init: has tensor            = false
ggml_metal_device_init: use residency sets    = true
ggml_metal_device_init: use shared buffers    = true
ggml_metal_device_init: recommendedMaxWorkingSetSize  = 115448.73 MB
Available devices:
  MTL0: Apple M4 Max (110100 MiB, 110100 MiB free)
  BLAS: Accelerate (0 MiB, 0 MiB free)`;

		const devices = parseDeviceOutput(output);
		expect(devices).toHaveLength(2);
		expect(devices[0]).toEqual({
			id: 'MTL0',
			name: 'Apple M4 Max',
			totalMiB: 110100,
			freeMiB: 110100,
		});
		expect(devices[1]).toEqual({
			id: 'BLAS',
			name: 'Accelerate',
			totalMiB: 0,
			freeMiB: 0,
		});
	});

	it('parses Windows CUDA output', () => {
		const output = `Available devices:
  CUDA0: Quadro P6000 (24575 MiB, 23490 MiB free)
  CUDA1: Quadro P6000 (24575 MiB, 23490 MiB free)`;

		const devices = parseDeviceOutput(output);
		expect(devices).toHaveLength(2);
		expect(devices[0]).toEqual({
			id: 'CUDA0',
			name: 'Quadro P6000',
			totalMiB: 24575,
			freeMiB: 23490,
		});
		expect(devices[1]).toEqual({
			id: 'CUDA1',
			name: 'Quadro P6000',
			totalMiB: 24575,
			freeMiB: 23490,
		});
	});

	it('handles output with no Available devices header', () => {
		const output = 'Some random output\nNothing useful here';
		const devices = parseDeviceOutput(output);
		expect(devices).toEqual([]);
	});

	it('handles empty output', () => {
		expect(parseDeviceOutput('')).toEqual([]);
	});

	it('handles devices with comma-formatted numbers', () => {
		const output = `Available devices:
  GPU0: Big Card (1,048,576 MiB, 1,000,000 MiB free)`;

		const devices = parseDeviceOutput(output);
		expect(devices).toHaveLength(1);
		expect(devices[0].totalMiB).toBe(1048576);
		expect(devices[0].freeMiB).toBe(1000000);
	});

	it('handles device lines without memory info', () => {
		const output = `Available devices:
  CPU0: Generic CPU
  GPU0: Card (8192 MiB, 7000 MiB free)`;

		const devices = parseDeviceOutput(output);
		expect(devices).toHaveLength(2);
		expect(devices[0]).toEqual({
			id: 'CPU0',
			name: 'Generic CPU',
			totalMiB: 0,
			freeMiB: 0,
		});
		expect(devices[1].totalMiB).toBe(8192);
	});

	it('stops parsing at non-indented line after devices', () => {
		const output = `Available devices:
  GPU0: Card (8192 MiB, 7000 MiB free)
Some other info after devices`;

		const devices = parseDeviceOutput(output);
		expect(devices).toHaveLength(1);
	});
});
