import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const EXTENSION_NAME = "comfy.combo_filter";
const SETTINGS_PANEL_LABEL = "Combo Filter";
const SETTINGS_SECTION_LABEL = "General";
const SETTINGS_INSTALL_FLAG = "__combo_filter_settings_installed";
const PATCH_RETRY_FLAG = "__combo_filter_retry_started";
const RETRY_INTERVAL_MS = 500;
const MAX_RETRY_COUNT = 240;
const GRAPH_REFRESH_ATTEMPTS = 20;
const GRAPH_REFRESH_DELAY_MS = 75;

const SETTING_IDS = {
	enabled: "combo_filter.enabled",
	rules_json: "combo_filter.rules_json",
	manage_rules: "combo_filter.manage_rules",
};

const DEFAULT_RULES = [
	{
		enabled: true,
		widget_name: "control_after_generate",
		mode: "whitelist",
		syntax: "wildcard",
		patterns: [
			"fixed"
		],
		keep_current_value: true
	},
	{
		enabled: true,
		widget_name: "sampler_name",
		mode: "whitelist",
		syntax: "wildcard",
		patterns: [
			"euler*",
			"lcm*",
			"ddim"
		],
		keep_current_value: true
	},
	{
		enabled: true,
		widget_name: "scheduler",
		mode: "whitelist",
		syntax: "wildcard",
		patterns: [
			"normal",
			"simple",
			"beta",
			"punch*",
			"kl_optimal"
		],
		keep_current_value: true
	},
	{
		enabled: false,
		widget_name: "unet_name",
		node_name: "UnetLoader*",
		mode: "blacklist",
		syntax: "wildcard",
		patterns: [
			"flux*experimental*"
		],
		keep_current_value: true
	}
];

const DEFAULT_RULES_JSON = JSON.stringify(DEFAULT_RULES, null, "\t");

const state = {
	enabled: true,
	rules_json: DEFAULT_RULES_JSON,
	rules: DEFAULT_RULES,
	rules_error: null,
	settings_access: null,
	manage_summary_element: null,
	manage_status_element: null,
	patch_retry_timer: null,
	patch_retry_count: 0,
};

let graph_refresh_token = 0;
let load_graph_hook_installed = false;

function build_setting_category(label)
{
	return [SETTINGS_PANEL_LABEL, SETTINGS_SECTION_LABEL, label];
}

function get_registered_node_types()
{
	const registered_node_types = globalThis?.LiteGraph?.registered_node_types;
	return registered_node_types && typeof registered_node_types === "object"
		? Object.values(registered_node_types)
		: [];
}

function load_local_setting(key, fallback)
{
	try
	{
		const stored_value = localStorage.getItem(key);
		if (stored_value === null)
		{
			return fallback;
		}

		return JSON.parse(stored_value);
	}
	catch (error)
	{
		return fallback;
	}
}

function save_local_setting(key, value)
{
	try
	{
		localStorage.setItem(key, JSON.stringify(value));
		return true;
	}
	catch (error)
	{
		return false;
	}
}

function get_settings_access()
{
	const extension_setting = app?.extensionManager?.setting;
	if (extension_setting && typeof extension_setting.get === "function")
	{
		return {
			get: (id, fallback) =>
			{
				const local_value = load_local_setting(id, undefined);
				if (local_value !== undefined)
				{
					return local_value;
				}

				const value = extension_setting.get(id);
				return value === undefined ? fallback : value;
			},
			set: (id, value) =>
			{
				if (typeof extension_setting.set === "function")
				{
					return extension_setting.set(id, value);
				}

				if (typeof extension_setting.setValue === "function")
				{
					return extension_setting.setValue(id, value);
				}

				return false;
			},
			add_setting: app?.ui?.settings?.addSetting?.bind(app.ui.settings) ?? null,
		};
	}

	const ui_settings = app?.ui?.settings;
	if (ui_settings && typeof ui_settings.getSettingValue === "function")
	{
		return {
			get: (id, fallback) =>
			{
				const local_value = load_local_setting(id, undefined);
				if (local_value !== undefined)
				{
					return local_value;
				}

				return ui_settings.getSettingValue(id, fallback);
			},
			set: (id, value) =>
			{
				if (typeof ui_settings.setSettingValue === "function")
				{
					return ui_settings.setSettingValue(id, value);
				}

				if (typeof ui_settings.setSetting === "function")
				{
					return ui_settings.setSetting(id, value);
				}

				return false;
			},
			add_setting: ui_settings.addSetting?.bind(ui_settings) ?? null,
		};
	}

	return null;
}

async function persist_setting(key, value)
{
	const local_saved = save_local_setting(key, value);
	let remote_saved = false;
	const settings_access = state.settings_access ?? get_settings_access();

	if (typeof settings_access?.set === "function")
	{
		try
		{
			const result = await settings_access.set(key, value);
			remote_saved = result !== false;
		}
		catch (error)
		{
			console.warn(`[combo_filter] Unable to save setting "${key}" through ComfyUI settings.`, error);
		}
	}

	if (typeof api?.storeSetting === "function")
	{
		try
		{
			const response = await api.storeSetting(key, value);
			remote_saved = response?.ok !== false || remote_saved;
		}
		catch (error)
		{
			console.warn(`[combo_filter] Unable to save setting "${key}" through ComfyUI API.`, error);
		}
	}

	if (!remote_saved && typeof api?.fetchApi === "function")
	{
		try
		{
			const response = await api.fetchApi(`/settings/${encodeURIComponent(key)}`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify(value),
			});

			remote_saved = response?.ok !== false;
		}
		catch (error)
		{
			console.warn(`[combo_filter] Unable to save setting "${key}" through the settings endpoint.`, error);
		}
	}

	return local_saved || remote_saved;
}

function request_canvas_redraw()
{
	try
	{
		app?.canvas?.setDirty?.(true, true);
	}
	catch (error)
	{
	}

	try
	{
		app?.graph?.setDirtyCanvas?.(true, true);
	}
	catch (error)
	{
	}
}

function normalize_enabled(value)
{
	return !!value;
}

function is_plain_object(value)
{
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function clone_values(values)
{
	return Array.isArray(values) ? values.slice() : [];
}

function get_widget_array_values(widget)
{
	if (Array.isArray(widget?.values))
	{
		return clone_values(widget.values);
	}

	return clone_values(widget?.options?.values);
}

function get_resolved_widget_values(widget)
{
	if (Array.isArray(widget?.__combo_filter_resolved_values))
	{
		return clone_values(widget.__combo_filter_resolved_values);
	}

	return get_widget_array_values(widget);
}

function unique_values(values)
{
	const deduped_values = [];
	const seen_values = new Set();

	for (const value of values)
	{
		const key = typeof value === "string" ? value : JSON.stringify(value);
		if (seen_values.has(key))
		{
			continue;
		}

		seen_values.add(key);
		deduped_values.push(value);
	}

	return deduped_values;
}

function parse_rules_json(raw_rules_json)
{
	const rules_json = typeof raw_rules_json === "string" ? raw_rules_json.trim() : "";
	if (!rules_json)
	{
		return {
			rules: [],
			pretty_json: "[]",
		};
	}

	let parsed_value = null;
	try
	{
		parsed_value = JSON.parse(rules_json);
	}
	catch (error)
	{
		throw new Error(`Rules JSON is not valid JSON: ${error.message}`);
	}

	if (!Array.isArray(parsed_value))
	{
		throw new Error("Rules JSON must be an array of rule objects.");
	}

	const normalized_rules = parsed_value.map((rule, index) =>
	{
		if (!is_plain_object(rule))
		{
			throw new Error(`Rule ${index + 1} must be an object.`);
		}

		const normalized_rule = {
			enabled: rule.enabled !== false,
			node_name: rule.node_name ?? rule.node_type ?? "*",
			widget_name: rule.widget_name ?? rule.input_name ?? rule.widget ?? "*",
			mode: String(rule.mode ?? "whitelist").toLowerCase(),
			syntax: String(rule.syntax ?? rule.pattern_syntax ?? "wildcard").toLowerCase(),
			patterns: Array.isArray(rule.patterns)
				? rule.patterns
				: (rule.patterns === undefined || rule.patterns === null ? [] : [rule.patterns]),
			keep_current_value: rule.keep_current_value !== false,
			case_sensitive: !!rule.case_sensitive,
		};

		if (normalized_rule.mode !== "whitelist" && normalized_rule.mode !== "blacklist")
		{
			throw new Error(`Rule ${index + 1} has invalid mode "${normalized_rule.mode}".`);
		}

		if (normalized_rule.syntax !== "wildcard"
			&& normalized_rule.syntax !== "regex"
			&& normalized_rule.syntax !== "literal")
		{
			throw new Error(`Rule ${index + 1} has invalid syntax "${normalized_rule.syntax}".`);
		}

		if (!Array.isArray(normalized_rule.patterns) || normalized_rule.patterns.length === 0)
		{
			throw new Error(`Rule ${index + 1} must define at least one pattern.`);
		}

		normalized_rule._node_matchers = build_selector_matchers(normalized_rule.node_name);
		normalized_rule._widget_matchers = build_selector_matchers(normalized_rule.widget_name);
		normalized_rule._pattern_matchers = normalized_rule.patterns.map((pattern) =>
			build_matcher(pattern, normalized_rule.syntax, normalized_rule.case_sensitive)
		);

		return normalized_rule;
	});

	return {
		rules: normalized_rules,
		pretty_json: JSON.stringify(parsed_value, null, "\t"),
	};
}

function load_state()
{
	state.settings_access = get_settings_access();
	const settings_access = state.settings_access;
	if (!settings_access)
	{
		return false;
	}

	state.enabled = normalize_enabled(
		settings_access.get(SETTING_IDS.enabled, true)
	);

	state.rules_json = String(
		settings_access.get(SETTING_IDS.rules_json, DEFAULT_RULES_JSON) ?? DEFAULT_RULES_JSON
	);

	try
	{
		const parsed_rules = parse_rules_json(state.rules_json);
		state.rules = parsed_rules.rules;
		state.rules_json = parsed_rules.pretty_json;
		state.rules_error = null;
	}
	catch (error)
	{
		state.rules = parse_rules_json(DEFAULT_RULES_JSON).rules;
		state.rules_error = error.message;
	}

	return true;
}

function count_active_rules(rules)
{
	let active_rule_count = 0;

	for (const rule of rules)
	{
		if (rule?.enabled !== false)
		{
			active_rule_count += 1;
		}
	}

	return active_rule_count;
}

function update_manage_rule_summary()
{
	if (state.manage_summary_element)
	{
		const active_rule_count = count_active_rules(state.rules);
		state.manage_summary_element.textContent = state.rules_error
			? `Invalid rules JSON. Using the last valid rules.`
			: `${active_rule_count} active rule${active_rule_count === 1 ? "" : "s"}.`;
	}

	if (state.manage_status_element)
	{
		state.manage_status_element.textContent = state.rules_error
			? state.rules_error
			: "Ordered rules are applied from top to bottom.";
		state.manage_status_element.style.color = state.rules_error ? "#d86c6c" : "#999";
	}
}

function escape_regex(value)
{
	return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function build_wildcard_regex_source(value)
{
	let regex_source = "";

	for (const character of value)
	{
		if (character === "*")
		{
			regex_source += ".*";
			continue;
		}

		if (character === "?")
		{
			regex_source += ".";
			continue;
		}

		regex_source += escape_regex(character);
	}

	return `^${regex_source}$`;
}

function parse_inline_regex(value, case_sensitive)
{
	if (typeof value !== "string" || value.length < 2 || value[0] !== "/")
	{
		return null;
	}

	const trailing_slash_index = value.lastIndexOf("/");
	if (trailing_slash_index <= 0)
	{
		return null;
	}

	const pattern = value.slice(1, trailing_slash_index);
	const inline_flags = value.slice(trailing_slash_index + 1);
	const flags = new Set(inline_flags.split(""));
	if (!case_sensitive)
	{
		flags.add("i");
	}

	const supported_flags = ["d", "g", "i", "m", "s", "u", "v", "y"];
	let normalized_flags = "";
	for (const flag of supported_flags)
	{
		if (flags.has(flag))
		{
			normalized_flags += flag;
		}
	}

	try
	{
		return new RegExp(pattern, normalized_flags);
	}
	catch (error)
	{
		throw new Error(`Invalid regex "${value}": ${error.message}`);
	}
}

function regex_matches(regex, value)
{
	regex.lastIndex = 0;
	return regex.test(String(value ?? ""));
}

function build_matcher(pattern, syntax, case_sensitive)
{
	if (pattern === null || pattern === undefined)
	{
		return null;
	}

	const pattern_text = String(pattern);
	const resolved_syntax = String(syntax ?? "wildcard").toLowerCase();

	if (resolved_syntax === "regex")
	{
		const inline_regex = parse_inline_regex(pattern_text, case_sensitive);
		if (inline_regex)
		{
			return (value) => regex_matches(inline_regex, value);
		}

		let regex_flags = case_sensitive ? "" : "i";
		try
		{
			const regex = new RegExp(pattern_text, regex_flags);
			return (value) => regex_matches(regex, value);
		}
		catch (error)
		{
			throw new Error(`Invalid regex "${pattern_text}": ${error.message}`);
		}
	}

	if (resolved_syntax === "literal")
	{
		const reference_value = case_sensitive ? pattern_text : pattern_text.toLowerCase();
		return (value) =>
		{
			const candidate_value = String(value ?? "");
			return case_sensitive
				? candidate_value === reference_value
				: candidate_value.toLowerCase() === reference_value;
		};
	}

	const regex_source = build_wildcard_regex_source(pattern_text);
	const regex_flags = case_sensitive ? "" : "i";
	const regex = new RegExp(regex_source, regex_flags);
	return (value) => regex_matches(regex, value);
}

function build_selector_matchers(selector)
{
	const selector_values = Array.isArray(selector) ? selector : [selector];
	const selector_matchers = [];

	for (const selector_value of selector_values)
	{
		if (selector_value === null || selector_value === undefined)
		{
			continue;
		}

		const selector_text = String(selector_value);
		if (!selector_text || selector_text === "*")
		{
			selector_matchers.push(() => true);
			continue;
		}

		const inline_regex = parse_inline_regex(selector_text, false);
		if (inline_regex)
		{
			selector_matchers.push((value) => regex_matches(inline_regex, value));
			continue;
		}

		if (selector_text.includes("*") || selector_text.includes("?"))
		{
			const regex = new RegExp(build_wildcard_regex_source(selector_text), "i");
			selector_matchers.push((value) => regex_matches(regex, value));
			continue;
		}

		const lowered_text = selector_text.toLowerCase();
		selector_matchers.push((value) => String(value ?? "").toLowerCase() === lowered_text);
	}

	return selector_matchers.length > 0 ? selector_matchers : [() => true];
}

function selector_matches(matchers, candidate)
{
	for (const matcher of matchers)
	{
		if (matcher(candidate))
		{
			return true;
		}
	}

	return false;
}

function is_combo_widget(widget)
{
	if (!widget)
	{
		return false;
	}

	if (Array.isArray(widget?.options?.values))
	{
		return true;
	}

	if (typeof widget?.type === "string" && widget.type.toLowerCase().includes("combo"))
	{
		return true;
	}

	return false;
}

function capture_original_values(widget)
{
	if (!widget)
	{
		return [];
	}

	if (!Array.isArray(widget.__combo_filter_original_values))
	{
		widget.__combo_filter_original_values = get_widget_array_values(widget);
	}

	return clone_values(widget.__combo_filter_original_values);
}

function get_property_descriptor_info(target, property_name)
{
	let current_target = target;

	while (current_target)
	{
		const descriptor = Object.getOwnPropertyDescriptor(current_target, property_name);
		if (descriptor)
		{
			return {
				owner: current_target,
				descriptor,
			};
		}

		current_target = Object.getPrototypeOf(current_target);
	}

	return null;
}

function set_widget_option_values(widget, next_option_values)
{
	if (!widget)
	{
		return false;
	}

	const widget_options = widget.options || {};
	widget.options = widget_options;

	const descriptor_info = get_property_descriptor_info(widget_options, "values");
	try
	{
		if (!descriptor_info
			|| descriptor_info.owner !== widget_options
			|| descriptor_info.descriptor.writable
			|| typeof descriptor_info.descriptor.set === "function")
		{
			widget_options.values = next_option_values;
			return widget?.options?.values === next_option_values;
		}
	}
	catch (error)
	{
	}

	try
	{
		if (Object.isExtensible(widget_options))
		{
			Object.defineProperty(widget_options, "values", {
				configurable: true,
				enumerable: true,
				writable: true,
				value: next_option_values,
			});
			return widget?.options?.values === next_option_values;
		}
	}
	catch (error)
	{
	}

	try
	{
		const replacement_options = Object.assign(
			Object.create(Object.getPrototypeOf(widget_options) || null),
			widget_options
		);

		Object.defineProperty(replacement_options, "values", {
			configurable: true,
			enumerable: true,
			writable: true,
			value: next_option_values,
		});

		widget.options = replacement_options;
		return widget?.options?.values === next_option_values;
	}
	catch (error)
	{
		if (!widget.__combo_filter_set_values_error_reported)
		{
			widget.__combo_filter_set_values_error_reported = true;
			console.warn(
				"[combo_filter] Unable to update combo values for widget:",
				widget?.name ?? "(unknown)",
				error
			);
		}
	}

	return false;
}

function set_widget_values(widget, values)
{
	if (!widget)
	{
		return false;
	}

	const cloned_values = clone_values(values);
	widget.__combo_filter_resolved_values = cloned_values;
	widget.values = clone_values(cloned_values);

	if (widget.__combo_filter_dynamic_values_bound && typeof widget?.options?.values === "function")
	{
		return true;
	}

	return set_widget_option_values(widget, cloned_values);
}

function get_node_name(node)
{
	return node?.comfyClass
		?? node?.constructor?.comfyClass
		?? node?.type
		?? node?.title
		?? "";
}

function build_rule_context(node, widget)
{
	return {
		node_name: get_node_name(node),
		widget_name: widget?.name ?? "",
	};
}

function rule_applies_to_context(rule, context)
{
	const node_matchers = Array.isArray(rule?._node_matchers)
		? rule._node_matchers
		: build_selector_matchers(rule?.node_name ?? "*");
	const widget_matchers = Array.isArray(rule?._widget_matchers)
		? rule._widget_matchers
		: build_selector_matchers(rule?.widget_name ?? "*");

	return selector_matches(node_matchers, context.node_name)
		&& selector_matches(widget_matchers, context.widget_name);
}

function rule_matches_value(rule, value)
{
	const matchers = Array.isArray(rule?._pattern_matchers)
		? rule._pattern_matchers
		: rule.patterns.map((pattern) => build_matcher(pattern, rule.syntax, rule.case_sensitive));

	for (const matcher of matchers)
	{
		if (matcher && matcher(value))
		{
			return true;
		}
	}

	return false;
}

function filter_values_for_widget(node, widget, original_values)
{
	let filtered_values = clone_values(original_values);
	let keep_current_value = false;
	const context = build_rule_context(node, widget);

	for (const rule of state.rules)
	{
		if (!rule?.enabled)
		{
			continue;
		}

		if (!rule_applies_to_context(rule, context))
		{
			continue;
		}

		keep_current_value = keep_current_value || rule.keep_current_value !== false;
		filtered_values = filtered_values.filter((value) =>
		{
			const matched = rule_matches_value(rule, value);
			return rule.mode === "whitelist" ? matched : !matched;
		});
	}

	const current_value = widget?.value;
	if (keep_current_value
		&& current_value !== null
		&& current_value !== undefined
		&& !filtered_values.includes(current_value))
	{
		filtered_values.unshift(current_value);
	}

	filtered_values = unique_values(filtered_values);

	if (filtered_values.length === 0)
	{
		if (current_value !== null && current_value !== undefined)
		{
			return [current_value];
		}

		return clone_values(original_values);
	}

	return filtered_values;
}

function refresh_combo_widget(node, widget)
{
	if (!is_combo_widget(widget))
	{
		return false;
	}

	const original_values = capture_original_values(widget);
	if (original_values.length === 0)
	{
		return false;
	}

	const next_values = state.enabled
		? filter_values_for_widget(node, widget, original_values)
		: original_values;

	return set_widget_values(widget, next_values);
}

function bind_dynamic_widget_values(node, widget)
{
	if (!is_combo_widget(widget) || widget.__combo_filter_dynamic_values_bound)
	{
		return false;
	}

	const values_resolver = function(widget_instance, node_instance)
	{
		const target_widget = widget_instance || this || widget;
		const target_node = node_instance || node || target_widget?.node;

		refresh_combo_widget(target_node, target_widget);
		return get_resolved_widget_values(target_widget);
	};

	if (!set_widget_option_values(widget, values_resolver))
	{
		return false;
	}

	widget.__combo_filter_dynamic_values_bound = true;
	return true;
}

function patch_combo_widget(node, widget)
{
	if (!is_combo_widget(widget))
	{
		return false;
	}

	refresh_combo_widget(node, widget);
	bind_dynamic_widget_values(node, widget);

	if (widget.__combo_filter_patched)
	{
		return true;
	}

	const original_mouse = widget.mouse;
	widget.mouse = function(event, pos, node_instance)
	{
		refresh_combo_widget(node_instance || node || this?.node, this);

		if (typeof original_mouse === "function")
		{
			return original_mouse.apply(this, arguments);
		}

		return false;
	};

	widget.__combo_filter_patched = true;
	return true;
}

function patch_node_combo_widgets(node)
{
	if (!Array.isArray(node?.widgets))
	{
		return false;
	}

	let patched_any = false;
	for (const widget of node.widgets)
	{
		if (patch_combo_widget(node, widget))
		{
			patched_any = true;
		}
	}

	return patched_any;
}

function walk_graph_nodes(graph, callback, visited_graphs = new Set())
{
	if (!graph || visited_graphs.has(graph))
	{
		return;
	}

	visited_graphs.add(graph);

	const nodes = Array.isArray(graph._nodes) ? graph._nodes : [];
	for (const node of nodes)
	{
		callback(node);

		if (node?.subgraph)
		{
			walk_graph_nodes(node.subgraph, callback, visited_graphs);
		}
	}
}

function refresh_all_combo_widgets()
{
	let patched_any = false;
	const visited_graphs = new Set();
	const graph_candidates = [
		app?.graph,
		app?.canvas?.graph,
	];

	for (const graph of graph_candidates)
	{
		walk_graph_nodes(graph, (node) =>
		{
			if (patch_node_combo_widgets(node))
			{
				patched_any = true;
			}
		}, visited_graphs);
	}

	if (patched_any)
	{
		request_canvas_redraw();
	}

	return patched_any;
}

function stop_patch_retry_loop()
{
	if (state.patch_retry_timer)
	{
		clearInterval(state.patch_retry_timer);
		state.patch_retry_timer = null;
	}

	state[PATCH_RETRY_FLAG] = false;
	state.patch_retry_count = 0;
}

function start_patch_retry_loop()
{
	if (state[PATCH_RETRY_FLAG])
	{
		return;
	}

	state[PATCH_RETRY_FLAG] = true;
	state.patch_retry_count = 0;
	state.patch_retry_timer = setInterval(() =>
	{
		state.patch_retry_count += 1;
		refresh_all_combo_widgets();

		if (state.patch_retry_count >= MAX_RETRY_COUNT)
		{
			stop_patch_retry_loop();
		}
	}, RETRY_INTERVAL_MS);
}

function schedule_combo_widget_refreshes(attempts = GRAPH_REFRESH_ATTEMPTS)
{
	graph_refresh_token += 1;
	const current_token = graph_refresh_token;

	const run_refresh = (remaining_attempts) =>
	{
		if (current_token !== graph_refresh_token)
		{
			return;
		}

		refresh_all_combo_widgets();

		if (remaining_attempts > 1)
		{
			setTimeout(() =>
			{
				run_refresh(remaining_attempts - 1);
			}, GRAPH_REFRESH_DELAY_MS);
		}
	};

	run_refresh(Math.max(1, attempts));
}

function install_load_graph_hook()
{
	if (load_graph_hook_installed || typeof app?.loadGraphData !== "function")
	{
		return;
	}

	const original_load_graph_data = app.loadGraphData;
	app.loadGraphData = async function()
	{
		const result = await original_load_graph_data.apply(this, arguments);
		schedule_combo_widget_refreshes();
		start_patch_retry_loop();
		return result;
	};

	load_graph_hook_installed = true;
}

async function apply_rules_json(next_rules_json)
{
	const parsed_rules = parse_rules_json(next_rules_json);
	state.rules_json = parsed_rules.pretty_json;
	state.rules = parsed_rules.rules;
	state.rules_error = null;

	const saved = await persist_setting(SETTING_IDS.rules_json, state.rules_json);
	if (!saved)
	{
		throw new Error("Rules were applied, but ComfyUI could not persist the rules setting.");
	}

	update_manage_rule_summary();
	refresh_all_combo_widgets();
}

function show_rules_dialog()
{
	const overlay = document.createElement("div");
	overlay.style.position = "fixed";
	overlay.style.inset = "0";
	overlay.style.background = "rgba(0, 0, 0, 0.6)";
	overlay.style.zIndex = "10000";

	const dialog = document.createElement("div");
	dialog.style.position = "fixed";
	dialog.style.top = "50%";
	dialog.style.left = "50%";
	dialog.style.transform = "translate(-50%, -50%)";
	dialog.style.width = "min(920px, calc(100vw - 32px))";
	dialog.style.maxHeight = "calc(100vh - 48px)";
	dialog.style.display = "flex";
	dialog.style.flexDirection = "column";
	dialog.style.gap = "12px";
	dialog.style.padding = "18px";
	dialog.style.background = "#1b1b1f";
	dialog.style.border = "1px solid #3a3a44";
	dialog.style.borderRadius = "10px";
	dialog.style.boxShadow = "0 12px 32px rgba(0, 0, 0, 0.35)";
	dialog.style.zIndex = "10001";

	const title = document.createElement("div");
	title.textContent = "Combo Filter Rules";
	title.style.fontSize = "18px";
	title.style.fontWeight = "600";
	dialog.appendChild(title);

	const description = document.createElement("div");
	description.textContent = "Define ordered whitelist or blacklist rules as JSON. Wildcards use * and ?, regex rules use syntax = \"regex\".";
	description.style.color = "#b7b7c0";
	description.style.fontSize = "13px";
	dialog.appendChild(description);

	const help = document.createElement("pre");
	help.textContent = [
		"[",
		"\t{",
		"\t\t\"enabled\": true,",
		"\t\t\"widget_name\": \"sampler_name\",",
		"\t\t\"node_name\": \"*\",",
		"\t\t\"mode\": \"whitelist\",",
		"\t\t\"syntax\": \"wildcard\",",
		"\t\t\"patterns\": [\"euler*\", \"lcm*\"],",
		"\t\t\"keep_current_value\": true",
		"\t},",
		"]"
	].join("\n");
	help.style.margin = "0";
	help.style.padding = "10px";
	help.style.background = "#111216";
	help.style.border = "1px solid #2f3138";
	help.style.borderRadius = "8px";
	help.style.color = "#9bc0ff";
	help.style.fontSize = "12px";
	help.style.overflow = "auto";
	dialog.appendChild(help);

	const textarea = document.createElement("textarea");
	textarea.value = state.rules_json;
	textarea.spellcheck = false;
	textarea.wrap = "off";
	textarea.style.width = "100%";
	textarea.style.minHeight = "360px";
	textarea.style.resize = "vertical";
	textarea.style.padding = "12px";
	textarea.style.fontFamily = "Consolas, Menlo, monospace";
	textarea.style.fontSize = "12px";
	textarea.style.lineHeight = "1.5";
	textarea.style.color = "#e8e8ef";
	textarea.style.background = "#0f1014";
	textarea.style.border = "1px solid #2f3138";
	textarea.style.borderRadius = "8px";
	textarea.addEventListener("keydown", (event) =>
	{
		if (event.key !== "Tab")
		{
			return;
		}

		event.preventDefault();

		const selection_start = textarea.selectionStart ?? 0;
		const selection_end = textarea.selectionEnd ?? selection_start;
		const current_value = textarea.value;
		const line_start = current_value.lastIndexOf("\n", Math.max(0, selection_start - 1)) + 1;
		const selection_text = current_value.slice(selection_start, selection_end);
		const has_multiline_selection = selection_text.includes("\n") || selection_start !== selection_end;

		if (!event.shiftKey)
		{
			if (!has_multiline_selection)
			{
				textarea.setRangeText("\t", selection_start, selection_end, "end");
				return;
			}

			const block_text = current_value.slice(line_start, selection_end);
			const indented_block_text = block_text.replace(/^/gm, "\t");
			textarea.setRangeText(indented_block_text, line_start, selection_end, "preserve");
			textarea.selectionStart = selection_start + 1;
			textarea.selectionEnd = selection_end + (indented_block_text.length - block_text.length);
			return;
		}

		const block_end = selection_end;
		const block_text = current_value.slice(line_start, block_end);
		const outdented_block_text = block_text.replace(/^(?:\t| {1,4})/gm, "");
		textarea.setRangeText(outdented_block_text, line_start, block_end, "preserve");
		textarea.selectionStart = Math.max(line_start, selection_start - 1);
		textarea.selectionEnd = Math.max(textarea.selectionStart, block_end - (block_text.length - outdented_block_text.length));
	});
	dialog.appendChild(textarea);

	const status = document.createElement("div");
	status.textContent = state.rules_error ?? "Ready.";
	status.style.minHeight = "20px";
	status.style.fontSize = "12px";
	status.style.color = state.rules_error ? "#d86c6c" : "#9aa0aa";
	dialog.appendChild(status);

	const button_row = document.createElement("div");
	button_row.style.display = "flex";
	button_row.style.justifyContent = "space-between";
	button_row.style.gap = "8px";
	dialog.appendChild(button_row);

	const left_buttons = document.createElement("div");
	left_buttons.style.display = "flex";
	left_buttons.style.gap = "8px";
	button_row.appendChild(left_buttons);

	const right_buttons = document.createElement("div");
	right_buttons.style.display = "flex";
	right_buttons.style.gap = "8px";
	button_row.appendChild(right_buttons);

	function close_dialog()
	{
		overlay.remove();
		dialog.remove();
	}

	function set_status(message, is_error = false)
	{
		status.textContent = message;
		status.style.color = is_error ? "#d86c6c" : "#9aa0aa";
	}

	const validate_button = document.createElement("button");
	validate_button.className = "comfy-btn";
	validate_button.textContent = "Validate";
	validate_button.onclick = () =>
	{
		try
		{
			const parsed_rules = parse_rules_json(textarea.value);
			set_status(`Valid JSON. ${count_active_rules(parsed_rules.rules)} active rule(s).`);
		}
		catch (error)
		{
			set_status(error.message, true);
		}
	};
	left_buttons.appendChild(validate_button);

	const reset_button = document.createElement("button");
	reset_button.className = "comfy-btn";
	reset_button.textContent = "Reset Example";
	reset_button.onclick = () =>
	{
		textarea.value = DEFAULT_RULES_JSON;
		set_status("Loaded example rules.");
	};
	left_buttons.appendChild(reset_button);

	const cancel_button = document.createElement("button");
	cancel_button.className = "comfy-btn";
	cancel_button.textContent = "Cancel";
	cancel_button.onclick = close_dialog;
	right_buttons.appendChild(cancel_button);

	const save_button = document.createElement("button");
	save_button.className = "comfy-btn";
	save_button.textContent = "Save";
	save_button.onclick = async () =>
	{
		try
		{
			set_status("Saving rules.");
			await apply_rules_json(textarea.value);
			set_status("Rules saved.");
			close_dialog();
		}
		catch (error)
		{
			set_status(error.message, true);
		}
	};
	right_buttons.appendChild(save_button);

	overlay.onclick = close_dialog;
	document.body.appendChild(overlay);
	document.body.appendChild(dialog);
	textarea.focus();
}

function create_manage_rules_setting_row()
{
	const row = document.createElement("tr");

	const label_cell = document.createElement("td");
	label_cell.className = "comfy-menu-label";
	label_cell.textContent = "Combo filter rules";
	row.appendChild(label_cell);

	const value_cell = document.createElement("td");
	value_cell.style.display = "flex";
	value_cell.style.flexDirection = "column";
	value_cell.style.alignItems = "flex-start";
	value_cell.style.gap = "6px";
	row.appendChild(value_cell);

	const button = document.createElement("button");
	button.className = "comfy-btn";
	button.textContent = "Edit Filter Rules";
	button.onclick = () =>
	{
		show_rules_dialog();
	};
	value_cell.appendChild(button);

	const summary = document.createElement("div");
	summary.style.fontSize = "12px";
	summary.style.color = "#b0b0b8";
	value_cell.appendChild(summary);

	const status = document.createElement("div");
	status.style.fontSize = "12px";
	status.style.maxWidth = "520px";
	value_cell.appendChild(status);

	state.manage_summary_element = summary;
	state.manage_status_element = status;
	update_manage_rule_summary();

	return row;
}

function install_settings()
{
	if (!app?.ui?.settings)
	{
		return false;
	}

	if (app.ui.settings[SETTINGS_INSTALL_FLAG])
	{
		return true;
	}

	state.settings_access = get_settings_access();
	if (!state.settings_access?.add_setting)
	{
		return false;
	}

	load_state();

	app.ui.settings[SETTINGS_INSTALL_FLAG] = true;

	state.settings_access.add_setting({
		id: SETTING_IDS.enabled,
		category: build_setting_category("Enabled"),
		name: "Enable Combo Filter",
		type: "boolean",
		defaultValue: state.enabled,
		onChange: (new_value) =>
		{
			state.enabled = normalize_enabled(new_value);
			persist_setting(SETTING_IDS.enabled, state.enabled);
			refresh_all_combo_widgets();
		}
	});

	state.settings_access.add_setting({
		id: SETTING_IDS.rules_json,
		category: build_setting_category("Rules"),
		name: "Combo filter rules",
		type: () => create_manage_rules_setting_row(),
		defaultValue: state.rules_json,
		onChange: (new_value) =>
		{
			try
			{
				const parsed_rules = parse_rules_json(String(new_value ?? ""));
				state.rules_json = parsed_rules.pretty_json;
				state.rules = parsed_rules.rules;
				state.rules_error = null;
				update_manage_rule_summary();
				refresh_all_combo_widgets();
			}
			catch (error)
			{
				state.rules_error = error.message;
				update_manage_rule_summary();
			}
		}
	});

	return true;
}

function install_node_hooks(node_type)
{
	if (!node_type?.prototype || node_type.prototype.__combo_filter_hooks_installed)
	{
		return;
	}

	node_type.prototype.__combo_filter_hooks_installed = true;

	const original_on_node_created = node_type.prototype.onNodeCreated;
	node_type.prototype.onNodeCreated = function()
	{
		const result = typeof original_on_node_created === "function"
			? original_on_node_created.apply(this, arguments)
			: undefined;
		patch_node_combo_widgets(this);
		return result;
	};

	const original_on_configure = node_type.prototype.onConfigure;
	node_type.prototype.onConfigure = function(info)
	{
		const result = typeof original_on_configure === "function"
			? original_on_configure.apply(this, arguments)
			: undefined;
		requestAnimationFrame(() =>
		{
			patch_node_combo_widgets(this);
		});
		return result;
	};
}

function install_existing_node_hooks()
{
	for (const node_type of get_registered_node_types())
	{
		install_node_hooks(node_type);
	}
}

app.registerExtension({
	name: EXTENSION_NAME,
	async setup()
	{
		if (app?.ui?.settings?.setup)
		{
			await app.ui.settings.setup;
		}

		load_state();

		const attempt_install = () =>
		{
			const settings_ready = install_settings();
			refresh_all_combo_widgets();

			if (!settings_ready)
			{
				requestAnimationFrame(attempt_install);
			}
		};

		attempt_install();
		install_load_graph_hook();
		install_existing_node_hooks();
		schedule_combo_widget_refreshes();
		start_patch_retry_loop();
	},
	async beforeRegisterNodeDef(node_type, node_data)
	{
		const inputs = [
			...(Object.values(node_data?.input?.required ?? {})),
			...(Object.values(node_data?.input?.optional ?? {})),
		];

		const has_combo_input = inputs.some((input_definition) => Array.isArray(input_definition?.[0]));
		if (!has_combo_input)
		{
			return;
		}

		install_node_hooks(node_type);
	}
});
