# ComfyUI-ComboFilter

Frontend-only ComfyUI extension that filters `COMBO` dropdown values with ordered whitelist and blacklist rules.

The goal is improving the UX for frequently-accessed lists, such as `sampler_name`, which may contain numerous entries you may have no interest in.

## What It Does

- Filters built-in and third-party `COMBO` widgets in the frontend.
- Supports ordered `whitelist` and `blacklist` rules.
- Supports `wildcard`, `literal`, and `regex` matching for dropdown values.
- Supports optional `node_name` scoping so the same widget name can be filtered differently on different node types.
- Preserves the currently selected hidden value by default so older workflows do not get silently rewritten.

## Configuration

Open ComfyUI settings and look for:

- `Combo Filter > General > Enabled`
- `Combo Filter > General > Rules`

Use the `Edit Filter Rules` button to manage the JSON rules.

## Rule Format

```json
[
	{
		"enabled": true,
		"widget_name": "sampler_name",
		"node_name": "*",
		"mode": "whitelist",
		"syntax": "wildcard",
		"patterns": [
			"euler*",
			"lcm*"
		],
		"keep_current_value": true
	},
	{
		"enabled": true,
		"widget_name": "scheduler",
		"mode": "whitelist",
		"syntax": "wildcard",
		"patterns": [
			"normal",
			"simple",
			"beta"
		],
		"keep_current_value": true
	}
]
```

## Fields

- `enabled`: Optional. Defaults to `true`.
- `widget_name`: Required. Matches the widget/input name, such as `sampler_name`, `scheduler`, or `unet_name`.
- `node_name`: Optional. Defaults to `*`. Matches the node type, such as `KSampler` or `UnetLoaderGGUF`.
- `mode`: Required. `whitelist` keeps matches. `blacklist` removes matches.
- `syntax`: Required. `wildcard`, `literal`, or `regex`.
- `patterns`: Required. One or more match patterns.
- `keep_current_value`: Optional. Defaults to `true`. Keeps the current selection visible even if a rule would hide it.
- `case_sensitive`: Optional. Defaults to `false`.

## Selector Matching

For `widget_name` and `node_name`:

- Plain text means literal match.
- `*` and `?` enable wildcard matching.
- `/.../flags` enables regex matching.

Examples:

- `"widget_name": "sampler_name"`
- `"node_name": "UnetLoader*"`
- `"node_name": "/^KSampler(Advanced)?$/"`

## Example Rules

Keep only a few common samplers:

```json
[
	{
		"enabled": true,
		"widget_name": "sampler_name",
		"mode": "whitelist",
		"syntax": "wildcard",
		"patterns": [
			"euler",
			"lcm"
		]
	}
]
```

Trim scheduler choices:

```json
[
	{
		"enabled": true,
		"widget_name": "scheduler",
		"mode": "whitelist",
		"syntax": "literal",
		"patterns": [
			"normal",
			"simple",
			"beta"
		]
	}
]
```

Hide experimental UNETs only on UNET loader nodes:

```json
[
	{
		"enabled": true,
		"widget_name": "unet_name",
		"node_name": "UnetLoader*",
		"mode": "blacklist",
		"syntax": "wildcard",
		"patterns": [
			"*experimental*",
			"*test*"
		]
	}
]
```

Use regex for value matching:

```json
[
	{
		"enabled": true,
		"widget_name": "sampler_name",
		"mode": "whitelist",
		"syntax": "regex",
		"patterns": [
			"^(euler|dpmpp_2m(?:_.+)?)$"
		]
	}
]
```

## Notes

- Rules are applied in order from top to bottom.
- This extension changes frontend dropdown visibility only. It does not remove backend support for any sampler, scheduler, or model.
- If a rule would hide every value, the extension keeps the current value or falls back to the original list to avoid breaking the dropdown.
