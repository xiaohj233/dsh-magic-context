/*!
 * @xiao_hj909/magic-context-for-dsh — client bundle (Phase 2 slice C).
 *
 * A minimal browser half for the persistent bundle:
 *
 *   1. `settings.section` entry (root scope, id "magic-context") — a READ-ONLY
 *      card that summarizes the Magic Context configuration essentials and
 *      points the user at the real editor target
 *      (`~/.config/cortexkit/magic-context.jsonc`). It deliberately exposes no
 *      write controls: the JSONC file stays the single source of truth and the
 *      card only mirrors live status, so there is no dual-source drift.
 *   2. `conversation.session.header.actions` entry (session scope, id
 *      "magic-context-status") — a per-session button that opens a status
 *      summary popover for that session.
 *
 * Client→Host channel: this package is a PERSISTENT bundle, so the
 * dynamic-package `host.call(method, args)` primitive does not exist here.
 * The real channel is the Typert Gateway over the shared `/api` RPC channel
 * (dsh-reference §F.4 / §G.1): the browser calls
 * `connection.rpc.call('/api', 'magicContext/status', { args })` and the host
 * half (src/host/remote.ts) serves the endpoint from a strict
 * `ctx.typert.register(...)` contribution. Every failure degrades to a
 * visible "endpoint unavailable" row instead of breaking the UI.
 *
 * Styling follows the official bundles: DSW alias tokens for colors/type and a
 * self-injected `<style data-plugin-css>` block (the pattern of
 * dsh-client-ui-jobs), plus `@deepseek-ai/dsh-client-ui-primitives` icons.
 *
 * Bundle contract: classic script registering via `window.__ModuleLoader__`
 * with the factory-form CJS shape used by the framework's own client bundles.
 */
window.__ModuleLoader__.load({
	id: "@xiao_hj909/magic-context-for-dsh",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var react = require("react");
		var jsxRuntime = require("react/jsx-runtime");
		var clientRuntime = require("@deepseek-ai/dsh-client-runtime/client");
		var primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		/* ------------------------------------------------ styles */
		var CSS_TAG_ID = "@xiao_hj909/magic-context-for-dsh/status.css";
		var css = [
			".ckmc-root{position:relative}",
			".ckmc-trigger{min-height:28px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:0;border-radius:6px;align-items:center;gap:5px;padding:3px 6px;font-size:12px;line-height:18px;display:inline-flex}",
			".ckmc-trigger:hover,.ckmc-trigger:focus-visible{color:var(--dsw-alias-label-secondary)}",
			".ckmc-triggerOpen{transform:rotate(180deg)}",
			".ckmc-menu{z-index:100;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-specific-menu);width:min(420px,calc(100vw - 32px));max-height:min(480px,calc(100vh - 140px));box-shadow:var(--dsw-shadow-lv3);border-radius:12px;padding:10px;position:absolute;top:calc(100% + 5px);left:0;overflow:auto}",
			".ckmc-card{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;padding:14px;min-width:0}",
			".ckmc-title{font-size:13px;line-height:18px;color:var(--dsw-alias-label-primary);font-weight:600;margin:0 0 4px}",
			".ckmc-desc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);margin:0 0 8px}",
			".ckmc-row{display:flex;justify-content:space-between;gap:12px;font-size:12px;line-height:20px;border-top:1px solid var(--dsw-alias-border-l2);padding:4px 0;min-width:0}",
			".ckmc-row:first-of-type{border-top:0}",
			".ckmc-label{color:var(--dsw-alias-label-tertiary);flex:none}",
			".ckmc-value{color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-mono);min-width:0;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".ckmc-valueOk{color:var(--dsw-alias-state-success-primary)}",
			".ckmc-valueErr{color:var(--dsw-alias-label-error)}",
			".ckmc-hint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);margin:8px 0 0}",
			".ckmc-btn{min-height:24px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:0 0;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:11px;line-height:16px;padding:2px 8px}",
			".ckmc-btn:hover{color:var(--dsw-alias-label-primary)}",
			".ckmc-actions{display:flex;gap:8px;align-items:center;margin-top:8px}",
			".ckmc-loading{font-size:12px;line-height:20px;color:var(--dsw-alias-label-tertiary)}"
		].join("");
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_TAG_ID) + "]") === null) {
			var tag = document.createElement("style");
			tag.dataset.plugin = "@xiao_hj909/magic-context-for-dsh";
			tag.dataset.pluginCss = CSS_TAG_ID;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var C = {
			root: "ckmc-root",
			trigger: "ckmc-trigger",
			triggerOpen: "ckmc-triggerOpen",
			menu: "ckmc-menu",
			card: "ckmc-card",
			title: "ckmc-title",
			desc: "ckmc-desc",
			row: "ckmc-row",
			label: "ckmc-label",
			value: "ckmc-value",
			valueOk: "ckmc-valueOk",
			valueErr: "ckmc-valueErr",
			hint: "ckmc-hint",
			btn: "ckmc-btn",
			actions: "ckmc-actions",
			loading: "ckmc-loading"
		};

		/* ------------------------------------- host communication */
		/** Typert Gateway endpoint served by src/host/remote.ts. */
		var STATUS_ENDPOINT = "magicContext/status";
		var CHANNEL = "/api";

		/**
		 * Call the host `magicContext/status` Remote through the persistent
		 * bundle's channel (connection.rpc over the shared /api transport).
		 * Never throws: transport or wiring failures collapse into an
		 * ok:false RpcResult-shaped value so the UI can render an
		 * "endpoint unavailable" row.
		 */
		function callStatus(connection, args) {
			if (connection === void 0 || connection === null || connection.rpc === void 0 || typeof connection.rpc.call !== "function") {
				return Promise.resolve({
					ok: false,
					error: { code: "unavailable", message: "connection.rpc is unavailable on this page", details: {} }
				});
			}
			var request = args === void 0 ? {} : args;
			return connection.rpc.call(CHANNEL, STATUS_ENDPOINT, { args: request }).then(
				function (result) {
					return result && typeof result === "object" && result.ok === false ? result : result;
				},
				function (error) {
					return {
						ok: false,
						error: { code: "transport", message: String(error && error.message !== void 0 ? error.message : error), details: {} }
					};
				}
			);
		}

		/**
		 * Tiny status controller: a snapshot store fed by one host call.
		 * The store is exposed through the slot inject face as the
		 * `useMagicStatus` hook (hooks seat of the slot contract).
		 */
		function StatusController(connection) {
			this.connection = connection;
			this.store = clientRuntime.createSnapshotStore({ state: "idle", status: null, error: null });
			this.refresh = this.refresh.bind(this);
		}
		StatusController.prototype.refresh = function (args) {
			var controller = this;
			controller.store.set({ state: "loading", status: null, error: null });
			return callStatus(controller.connection, args).then(function (result) {
				if (result.ok === true) {
					controller.store.set({ state: "ready", status: result.value, error: null });
				} else {
					controller.store.set({ state: "error", status: null, error: result.error });
				}
			});
		};

		/* ------------------------------------------------ rows */
		function storageText(status) {
			if (status.storage === void 0 || status.storage === null) return "unknown";
			if (status.storage.ok === true) {
				return "ok · schema v" + status.storage.schemaVersion + "/" + status.storage.latestSupported;
			}
			var reason = status.storage.reason !== void 0 ? status.storage.reason : "error";
			return reason + (status.storage.detail !== void 0 && status.storage.detail !== "" ? " · " + status.storage.detail : "");
		}

		function summaryRows(status) {
			return [
				{ label: "harness", value: "dsh", tone: "ok" },
				{ label: "storage", value: storageText(status), tone: status.storage && status.storage.ok ? "ok" : "err" },
				{ label: "config", value: status.config && status.config.exists ? "present" : "missing", tone: status.config && status.config.exists ? "ok" : "err" },
				{ label: "preset", value: status.preset && status.preset.exists ? "generated" : "missing", tone: status.preset && status.preset.exists ? "ok" : "err" },
				{ label: "session", value: status.sessionId !== void 0 && status.sessionId !== null ? status.sessionId : "—" }
			];
		}

		/** Shared status body: loading → rows / error, with a refresh button. */
		function StatusSummary(props) {
			var snapshot = props.useMagicStatus(function (state) { return state; });
			var rows = snapshot.status === null ? [] : summaryRows(snapshot.status);
			return jsxRuntime.jsxs("div", {
				className: C.card,
				children: [
					jsxRuntime.jsx("h3", { className: C.title, children: "Magic Context 状态" }),
					jsxRuntime.jsx("p", { className: C.desc, children: "@xiao_hj909/magic-context-for-dsh · DSH 适配器" }),
					snapshot.state === "loading"
						? jsxRuntime.jsx("p", { className: C.loading, children: "读取状态…" })
						: snapshot.state === "error"
							? rows.length === 0
								? jsxRuntime.jsx("p", { className: C.loading, children: "主机端点不可用：" + (snapshot.error && snapshot.error.message !== void 0 ? snapshot.error.message : "unknown") + "（需要 host 半侧注册 magicContext/status）" })
								: null
							: null,
					snapshot.state === "ready" && snapshot.status !== null
						? jsxRuntime.jsx("div", {
							children: rows.map(function (row) {
								return jsxRuntime.jsxs("div", {
									className: C.row,
									children: [
										jsxRuntime.jsx("span", { className: C.label, children: row.label }),
										jsxRuntime.jsx("span", { className: row.tone === "ok" ? C.value + " " + C.valueOk : C.value + " " + C.valueErr, title: row.value, children: row.value })
									]
								}, row.label);
							})
						})
						: null,
					jsxRuntime.jsx("p", { className: C.hint, children: "配置源：~/.config/cortexkit/magic-context.jsonc —— 此界面只读，请用编辑器修改。" }),
					jsxRuntime.jsx("div", {
						className: C.actions,
						children: [
							jsxRuntime.jsx("button", {
								type: "button",
								className: C.btn,
								disabled: snapshot.state === "loading",
								onClick: function () { props.onRefresh(); },
								children: "刷新"
							}),
							props.onClose !== void 0
								? jsxRuntime.jsx("button", {
									type: "button",
									className: C.btn,
									onClick: props.onClose,
									children: "关闭"
								})
								: null
						]
					})
				]
			});
		}

		/* ------------------------------- settings.section entry */
		/**
		 * Read-only settings section. It mirrors the live status and the
		 * config location; it intentionally offers no form controls — the
		 * JSONC file is the single source of truth.
		 */
		function MagicSettingsSection(props) {
			return jsxRuntime.jsx("div", {
				className: C.root,
				children: jsxRuntime.jsxs(StatusSummary, {
					useMagicStatus: props.useMagicStatus,
					onRefresh: function () { props.refresh({}); }
				}, null)
			});
		}

		/* -------------------- header action entry (session) */
		function MagicHeaderAction(props) {
			var openState = react.useState(false);
			var open = openState[0];
			var setOpen = openState[1];
			var rootRef = react.useRef(null);
			var triggerRef = react.useRef(null);
			var openedRef = react.useRef(false);
			react.useEffect(function () {
				if (!open) return;
				if (!openedRef.current) {
					openedRef.current = true;
					props.refresh({ sessionId: props.sessionId });
				}
				var closeOutside = function (event) {
					if (event.target instanceof Node && !rootRef.current.contains(event.target)) setOpen(false);
				};
				var onKeyDown = function (event) {
					if (event.key === "Escape" && open) {
						event.preventDefault();
						setOpen(false);
						triggerRef.current && triggerRef.current.focus();
					}
				};
				document.addEventListener("pointerdown", closeOutside);
				document.addEventListener("keydown", onKeyDown);
				return function () {
					document.removeEventListener("pointerdown", closeOutside);
					document.removeEventListener("keydown", onKeyDown);
				};
			}, [open, props]);
			return jsxRuntime.jsx("div", {
				ref: rootRef,
				className: C.root,
				children: [
					jsxRuntime.jsxs("button", {
						ref: triggerRef,
						type: "button",
						className: C.trigger,
						"aria-expanded": open ? "true" : "false",
						"aria-label": "Magic Context 状态",
						title: "Magic Context 状态",
						onClick: function () { setOpen(!open); },
						children: [
							jsxRuntime.jsx("span", { children: "MC" }),
							jsxRuntime.jsx(primitives.IconChevronDownOutline14, {
								className: open ? C.triggerOpen : void 0
							})
						]
					}),
					open
						? jsxRuntime.jsx("div", {
							className: C.menu,
							children: jsxRuntime.jsx(StatusSummary, {
								useMagicStatus: props.useMagicStatus,
								onRefresh: function () { props.refresh({ sessionId: props.sessionId }); },
								onClose: function () { setOpen(false); }
							})
						})
						: null
				]
			});
		}

		/* ------------------------------------------------ mount */
		function apply(ctx) {
			var connection = ctx.get("connection");
			// One controller per slot: the settings section is root-scoped and
			// refreshes with no session, while the header action is session-
			// scoped — sharing one store would let the header action's last
			// session leak into the settings card's rows.
			var sectionController = new StatusController(connection);
			var headerController = new StatusController(connection);

			ctx.slots.inject("settings.section", function () {
				return ctx.slots.register({
					name: "settings.section",
					id: "magic-context",
					order: 60,
					label: "Magic Context",
					inject: function () {
						return {
							hooks: { magicStatus: sectionController.store },
							refresh: sectionController.refresh
						};
					}
				}, MagicSettingsSection);
			});

			ctx.slots.inject("conversation.session.header.actions", function () {
				return ctx.slots.register({
					name: "conversation.session.header.actions",
					id: "magic-context-status",
					order: 40,
					label: "Magic Context 状态",
					inject: function () {
						return {
							hooks: { magicStatus: headerController.store },
							refresh: headerController.refresh
						};
					}
				}, MagicHeaderAction);
			});
		}

		exports.name = "@xiao_hj909/magic-context-for-dsh";
		exports.inject = ["slots", "connection"];
		exports.apply = apply;
		return module.exports;
	}
});
