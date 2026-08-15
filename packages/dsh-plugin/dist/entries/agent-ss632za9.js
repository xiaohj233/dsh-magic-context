import {
  Lifetime,
  QuickJSContext,
  QuickJSNotImplemented,
  QuickJSRuntime,
  QuickJSWASMModule,
  Scope,
  applyBaseRuntimeOptions,
  applyModuleEvalRuntimeOptions,
  evalOptionsToFlags,
  intrinsicsToFlags
} from "./agent-dynqfgx1.js";

// ../../node_modules/.bun/quickjs-emscripten-core@0.32.0/node_modules/quickjs-emscripten-core/dist/chunk-TAV5CUKK.mjs
var QuickJSAsyncContext = class extends QuickJSContext {
  async evalCodeAsync(code, filename = "eval.js", options) {
    let detectModule = options === undefined ? 1 : 0, flags = evalOptionsToFlags(options), resultPtr = 0;
    try {
      resultPtr = await this.memory.newHeapCharPointer(code).consume((charHandle) => this.ffi.QTS_Eval_MaybeAsync(this.ctx.value, charHandle.value.ptr, charHandle.value.strlen, filename, detectModule, flags));
    } catch (error) {
      throw this.runtime.debugLog("QTS_Eval_MaybeAsync threw", error), error;
    }
    let errorPtr = this.ffi.QTS_ResolveException(this.ctx.value, resultPtr);
    return errorPtr ? (this.ffi.QTS_FreeValuePointer(this.ctx.value, resultPtr), this.fail(this.memory.heapValueHandle(errorPtr))) : this.success(this.memory.heapValueHandle(resultPtr));
  }
  newAsyncifiedFunction(name, fn) {
    return this.newFunction(name, fn);
  }
};
var QuickJSAsyncRuntime = class extends QuickJSRuntime {
  constructor(args) {
    super(args);
  }
  newContext(options = {}) {
    let intrinsics = intrinsicsToFlags(options.intrinsics), ctx = new Lifetime(this.ffi.QTS_NewContext(this.rt.value, intrinsics), undefined, (ctx_ptr) => {
      this.contextMap.delete(ctx_ptr), this.callbacks.deleteContext(ctx_ptr), this.ffi.QTS_FreeContext(ctx_ptr);
    }), context = new QuickJSAsyncContext({ module: this.module, ctx, ffi: this.ffi, rt: this.rt, ownedLifetimes: [], runtime: this, callbacks: this.callbacks });
    return this.contextMap.set(ctx.value, context), context;
  }
  setModuleLoader(moduleLoader, moduleNormalizer) {
    super.setModuleLoader(moduleLoader, moduleNormalizer);
  }
  setMaxStackSize(stackSize) {
    return super.setMaxStackSize(stackSize);
  }
};
var QuickJSAsyncWASMModule = class extends QuickJSWASMModule {
  constructor(module, ffi) {
    super(module, ffi);
    this.ffi = ffi, this.module = module;
  }
  newRuntime(options = {}) {
    let rt = new Lifetime(this.ffi.QTS_NewRuntime(), undefined, (rt_ptr) => {
      this.callbacks.deleteRuntime(rt_ptr), this.ffi.QTS_FreeRuntime(rt_ptr);
    }), runtime = new QuickJSAsyncRuntime({ module: this.module, ffi: this.ffi, rt, callbacks: this.callbacks });
    return applyBaseRuntimeOptions(runtime, options), options.moduleLoader && runtime.setModuleLoader(options.moduleLoader), runtime;
  }
  newContext(options = {}) {
    let runtime = this.newRuntime(), lifetimes = options.ownedLifetimes ? options.ownedLifetimes.concat([runtime]) : [runtime], context = runtime.newContext({ ...options, ownedLifetimes: lifetimes });
    return runtime.context = context, context;
  }
  evalCode() {
    throw new QuickJSNotImplemented("QuickJSWASMModuleAsyncify.evalCode: use evalCodeAsync instead");
  }
  evalCodeAsync(code, options) {
    return Scope.withScopeAsync(async (scope) => {
      let vm = scope.manage(this.newContext());
      applyModuleEvalRuntimeOptions(vm.runtime, options);
      let result = await vm.evalCodeAsync(code, "eval.js");
      if (options.memoryLimitBytes !== undefined && vm.runtime.setMemoryLimit(-1), result.error)
        throw vm.dump(scope.manage(result.error));
      return vm.dump(scope.manage(result.value));
    });
  }
};

export { QuickJSAsyncContext, QuickJSAsyncRuntime, QuickJSAsyncWASMModule };
