/// <reference lib="webworker" />

import type { PyodideInterface } from "pyodide";
import type {
	InMessage,
	ReplyMessageError,
	ReplyMessageSuccess
} from "../message-types";
import { makeHttpRequest } from "./http";

importScripts("https://cdn.jsdelivr.net/pyodide/v0.23.2/full/pyodide.js");

let pyodide: PyodideInterface;

let pyodideReadyPromise: undefined | Promise<void> = undefined;

let call_asgi_app_from_js: (
	scope: unknown,
	receive: Function,
	send: Function
) => Promise<void>;

interface InitOptions {
	gradioWheelUrl: string;
	gradioClientWheelUrl: string;
	requirements: string[];
}
async function loadPyodideAndPackages(options: InitOptions) {
	console.debug("Loading Pyodide.");
	pyodide = await loadPyodide();
	console.debug("Pyodide is loaded.");

	console.debug("Loading micropip");
	await pyodide.loadPackage("micropip");
	const micropip = pyodide.pyimport("micropip");
	console.debug("micropip is loaded.");

	const gradioWheelUrls = [
		options.gradioWheelUrl,
		options.gradioClientWheelUrl
	];
	console.debug("Loading Gradio wheels.", gradioWheelUrls);
	await micropip.add_mock_package("ffmpy", "0.3.0");
	await micropip.add_mock_package("orjson", "3.8.12");
	await micropip.add_mock_package("aiohttp", "3.8.4");
	await micropip.add_mock_package("multidict", "4.7.6");
	await pyodide.loadPackage(["ssl", "distutils", "setuptools"]);
	await micropip.install.callKwargs(gradioWheelUrls, {
		keep_going: true
	});
	console.debug("Gradio wheels are loaded.");

	console.debug("Install packages.", options.requirements);
	await micropip.install.callKwargs(options.requirements, { keep_going: true });
	console.debug("Packages are installed.");

	console.debug("Import gradio package.");
	// Importing the gradio package takes a long time, so we do it separately.
	// This is necessary for accurate performance profiling.
	await pyodide.runPythonAsync(`import gradio`);
	console.debug("gradio package is imported.");

	console.debug("Define a ASGI wrapper function.");
	// TODO: Unlike Streamlit, user's code is executed in the global scope,
	//       so we should not define this function in the global scope.
	await pyodide.runPythonAsync(`
# Based on Shiny's App.call_pyodide().
# https://github.com/rstudio/py-shiny/blob/v0.3.3/shiny/_app.py#L224-L258
async def _call_asgi_app_from_js(scope, receive, send):
	# TODO: Pretty sure there are objects that need to be destroy()'d here?
	scope = scope.to_py()

	# ASGI requires some values to be byte strings, not character strings. Those are
	# not that easy to create in JavaScript, so we let the JS side pass us strings
	# and we convert them to bytes here.
	if "headers" in scope:
			# JS doesn't have \`bytes\` so we pass as strings and convert here
			scope["headers"] = [
					[value.encode("latin-1") for value in header]
					for header in scope["headers"]
			]
	if "query_string" in scope and scope["query_string"]:
			scope["query_string"] = scope["query_string"].encode("latin-1")
	if "raw_path" in scope and scope["raw_path"]:
			scope["raw_path"] = scope["raw_path"].encode("latin-1")

	async def rcv():
			event = await receive()
			return event.to_py()

	async def snd(event):
			await send(event)

	app = gradio.wasm_utils.get_registered_app()
	if app is None:
		raise RuntimeError("Gradio app has not been launched.")

	await app(scope, rcv, snd)
`);
	call_asgi_app_from_js = pyodide.globals.get("_call_asgi_app_from_js");
	console.debug("The ASGI wrapper function is defined.");

	console.debug("Mock async libraries.");
	// FastAPI uses `anyio.to_thread.run_sync` internally which, however, doesn't work in Wasm environments where the `threading` module is not supported.
	// So we mock `anyio.to_thread.run_sync` here not to use threads.
	await pyodide.runPythonAsync(`
async def mocked_anyio_to_thread_run_sync(func, *args, cancellable=False, limiter=None):
	return func(*args)

import anyio.to_thread
anyio.to_thread.run_sync = mocked_anyio_to_thread_run_sync
	`);
	console.debug("Async libraries are mocked.");

	console.debug("Set matplotlib backend.");
	// Ref: https://github.com/streamlit/streamlit/blob/1.22.0/lib/streamlit/web/bootstrap.py#L111
	// This backend setting is required to use matplotlib in Wasm environment.
	await pyodide.runPythonAsync(`
import matplotlib
matplotlib.use("agg")
`);
	console.debug("matplotlib backend is set.");
}

self.onmessage = async (event: MessageEvent<InMessage>) => {
	const msg = event.data;
	console.debug("worker.onmessage", msg);

	const messagePort = event.ports[0];

	try {
		if (msg.type === "init") {
			pyodideReadyPromise = loadPyodideAndPackages({
				gradioWheelUrl: msg.data.gradioWheelUrl,
				gradioClientWheelUrl: msg.data.gradioClientWheelUrl,
				requirements: msg.data.requirements
			});

			const replyMessage: ReplyMessageSuccess = {
				type: "reply:success",
				data: null
			};
			messagePort.postMessage(replyMessage);
		}

		if (pyodideReadyPromise == null) {
			throw new Error("Pyodide Initialization is not started.");
		}

		await pyodideReadyPromise;

		switch (msg.type) {
			case "echo": {
				const replyMessage: ReplyMessageSuccess = {
					type: "reply:success",
					data: msg.data
				};
				messagePort.postMessage(replyMessage);
				break;
			}
			case "run-python": {
				const result = await pyodide.runPythonAsync(msg.data.code);
				const replyMessage: ReplyMessageSuccess = {
					type: "reply:success",
					data: {
						result
					}
				};
				messagePort.postMessage(replyMessage);
				break;
			}
			case "http-request": {
				const request = msg.data.request;
				const response = await makeHttpRequest(call_asgi_app_from_js, request);
				const replyMessage: ReplyMessageSuccess = {
					type: "reply:success",
					data: {
						response
					}
				};
				messagePort.postMessage(replyMessage);
				break;
			}
		}
	} catch (error) {
		const replyMessage: ReplyMessageError = {
			type: "reply:error",
			error: error as Error
		};
		messagePort.postMessage(replyMessage);
	}
};
