#!/usr/bin/env python3
"""Launches a scratch Firefox with the debugger server on, installs the
extension as a temporary add-on over RDP, and evaluates JS in a tab."""
import json, os, subprocess, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rdp import RDP

FIREFOX = "/Applications/Firefox.app/Contents/MacOS/firefox"
PORT = 6001

def make_profile(path):
    os.makedirs(path, exist_ok=True)
    with open(os.path.join(path, "user.js"), "w") as f:
        f.write("""
user_pref("devtools.debugger.remote-enabled", true);
user_pref("devtools.debugger.prompt-connection", false);
user_pref("devtools.chrome.enabled", true);
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("browser.aboutwelcome.enabled", false);
user_pref("datareporting.policy.firstRunURL", "");
user_pref("datareporting.policy.dataSubmissionPolicyBypassNotification", true);
user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);
user_pref("browser.startup.homepage_override.mstone", "ignore");
user_pref("extensions.autoDisableScopes", 0);
""".strip())

def launch(profile, url):
    return subprocess.Popen(
        [FIREFOX, "--profile", profile, "--no-remote",
         "--start-debugger-server", str(PORT), url],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

def connect(retries=40):
    for _ in range(retries):
        try:
            return RDP(port=PORT)
        except Exception:
            time.sleep(1)
    raise RuntimeError("could not reach the debugger server")

def install(rdp, addon_dir):
    root = rdp.request({"to": "root", "type": "getRoot"}, match=lambda p: "addonsActor" in p or "addonsheet" in str(p))
    actor = root.get("addonsActor")
    if not actor:
        raise RuntimeError(f"no addons actor: {list(root)[:12]}")
    return rdp.request({"to": actor, "type": "installTemporaryAddon", "addonPath": addon_dir},
                       match=lambda p: "addon" in p or "error" in p)

if __name__ == "__main__":
    cmd = sys.argv[1]
    profile = sys.argv[2]
    if cmd == "start":
        url = sys.argv[3]
        addon = sys.argv[4]
        make_profile(profile)
        launch(profile, url)
        rdp = connect()
        print(json.dumps({"install": install(rdp, addon)}, indent=1)[:600])
    elif cmd == "eval":
        want = sys.argv[3]
        expr = sys.stdin.read()
        rdp = RDP(port=PORT)
        tabs = rdp.tabs()
        matches = [t for t in tabs if want in (t.get("url") or "")]
        if not matches:
            print(json.dumps({"error": "no tab", "tabs": [t.get("url") for t in tabs]}))
            sys.exit(0)
        target = next((t for t in matches if t.get("selected")), matches[0])
        console = rdp.console_for(target)
        reply = rdp.eval(console, expr)
        print(json.dumps({"url": target.get("url"), "result": reply.get("result"),
                          "exception": reply.get("exceptionMessage")}, indent=1))
