# /// script
# requires-python = ">=3.12"
# ///
"""Bundles the Nudges Theme JS into the single file Canvas will load."""

import argparse
import datetime as dt
import json
import re
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")
PLACEMENTS = {"top", "bottom", "left", "right"}
RULE_FIELDS = (
    "id",
    "version",
    "enabled",
    "url_pattern",
    "element_selector",
    "content",
    "placement",
    "audience",
    "dismissible",
)


def is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def validate_rule(rule, index):
    label = f"rule[{index}]"
    if not isinstance(rule, dict):
        return [f"{label}: must be an object"]

    errors = []
    for field in RULE_FIELDS:
        if field not in rule:
            errors.append(f"{label}: missing field '{field}'")
    if errors:
        return errors

    rule_id = rule["id"]
    label = f"rule '{rule_id}'" if isinstance(rule_id, str) and rule_id else label

    if not isinstance(rule_id, str) or not rule_id:
        errors.append(f"{label}: 'id' must be a non-empty string")
    elif not ID_RE.match(rule_id):
        errors.append(f"{label}: 'id' must match {ID_RE.pattern!r}")

    if not is_int(rule["version"]):
        errors.append(f"{label}: 'version' must be an int")
    if not isinstance(rule["enabled"], bool):
        errors.append(f"{label}: 'enabled' must be a bool")
    if not isinstance(rule["dismissible"], bool):
        errors.append(f"{label}: 'dismissible' must be a bool")

    for field in ("url_pattern", "element_selector", "content"):
        if not isinstance(rule[field], str) or not rule[field]:
            errors.append(f"{label}: '{field}' must be a non-empty string")

    if rule["placement"] not in PLACEMENTS:
        errors.append(f"{label}: 'placement' must be one of {sorted(PLACEMENTS)}")

    if not isinstance(rule["audience"], dict):
        errors.append(f"{label}: 'audience' must be an object")

    return errors


def validate_rules(data):
    if not isinstance(data, dict):
        return ["top level: rules.json must be an object"]

    errors = []

    if not is_int(data.get("version")):
        errors.append("top level: 'version' must be an int")
    if not isinstance(data.get("kill_switch"), bool):
        errors.append("top level: 'kill_switch' must be a bool")
    if not isinstance(data.get("rules"), list):
        errors.append("top level: 'rules' must be a list")
        return errors

    seen_ids = set()
    for index, rule in enumerate(data["rules"]):
        errors.extend(validate_rule(rule, index))
        if isinstance(rule, dict):
            rule_id = rule.get("id")
            if isinstance(rule_id, str) and rule_id:
                if rule_id in seen_ids:
                    errors.append(f"rule '{rule_id}': duplicate id")
                seen_ids.add(rule_id)

    return errors


def wrap_umd(source):
    # A UMD build checks `define.amd` first and, if an AMD loader is on the
    # page (Canvas pages can carry one), registers as an anonymous module
    # instead of setting its browser global, leaving e.g. FloatingUIDOM
    # undefined. Shadowing define/exports/module forces the global branch.
    return f"(function(){{var define,exports,module;\n{source}\n}})();"


def build_bundle(rules_version, nudges_js, core_umd, dom_umd, sdk_js, rules_url):
    if "__RULES_URL__" not in sdk_js:
        raise SystemExit("src/surface-sdk.js does not contain __RULES_URL__")

    timestamp = dt.datetime.now().isoformat(timespec="seconds")
    header = f"// kaplan-theme.js built {timestamp} rules version {rules_version}"
    parts = [
        header,
        nudges_js,
        wrap_umd(core_umd),
        wrap_umd(dom_umd),
        sdk_js.replace("__RULES_URL__", rules_url),
    ]
    return "\n;\n".join(parts) + "\n"


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rules-base", default="http://localhost:3101")
    parser.add_argument(
        "--out-dir", default="D:/Canvas/test/canvas/cplatform/nudges/theme"
    )
    return parser.parse_args()


def main():
    args = parse_args()
    out_dir = Path(args.out_dir)

    rules_path = SCRIPT_DIR / "rules.json"
    sdk_path = SCRIPT_DIR / "src" / "surface-sdk.js"
    core_path = (
        SCRIPT_DIR
        / "node_modules"
        / "@floating-ui"
        / "core"
        / "dist"
        / "floating-ui.core.umd.min.js"
    )
    dom_path = (
        SCRIPT_DIR
        / "node_modules"
        / "@floating-ui"
        / "dom"
        / "dist"
        / "floating-ui.dom.umd.min.js"
    )
    nudges_path = out_dir / "nudges.js"

    for path in (rules_path, sdk_path, core_path, dom_path, nudges_path):
        if not path.is_file():
            raise SystemExit(f"missing input file: {path}")

    rules_bytes = rules_path.read_bytes()
    try:
        rules_data = json.loads(rules_bytes)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"rules.json is not valid JSON: {exc}")

    errors = validate_rules(rules_data)
    if errors:
        for error in errors:
            print(error)
        raise SystemExit(1)

    rules_url = f"{args.rules_base}/rules.json?v={rules_data['version']}"
    bundle = build_bundle(
        rules_data["version"],
        nudges_path.read_text(encoding="utf-8"),
        core_path.read_text(encoding="utf-8"),
        dom_path.read_text(encoding="utf-8"),
        sdk_path.read_text(encoding="utf-8"),
        rules_url,
    )

    out_rules_path = out_dir / "rules.json"
    out_bundle_path = out_dir / "kaplan-theme.js"
    out_rules_path.write_bytes(rules_bytes)
    out_bundle_path.write_text(bundle, encoding="utf-8", newline="\n")

    for path in (out_rules_path, out_bundle_path):
        print(f"{path.resolve()} ({path.stat().st_size} bytes)")
    print(f"rules URL: {rules_url}")


if __name__ == "__main__":
    main()
