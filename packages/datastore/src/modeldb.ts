// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import {
  IModelDB,
  ICollaboratorMap,
  IObservable,
  IObservableString,
  IObservableUndoableList,
  IObservableValue,
  IObservableJSON,
  ObservableMap
} from '@jupyterlab/observables';

import { toArray } from '@phosphor/algorithm';

import { ReadonlyJSONValue } from '@phosphor/coreutils';

import { Schema } from '@phosphor/datastore';

import { DisposableSet } from '@phosphor/disposable';

import {
  ObservableJSON,
  ObservableString,
  ObservableUndoableList,
  ObservableValue
} from './observables';

import { iterValues } from './objiter';

import { DatastoreManager } from './manager';

/**
 *
 */
export class DSModelDB implements IModelDB {
  /**
   *
   */
  constructor(options: DSModelDB.ICreateOptions) {
    this._basePath = options.basePath || options.schemas[0].id;
    if (options.baseDB) {
      this._baseDB = options.baseDB;
    } else {
      this._baseDB = new ObservableMap<IObservable>();
      this._toDispose = true;
    }
    this._schemas = {};
    this._recordId = options.recordId;
    for (let s of options.schemas) {
      this._schemas[s.id] = s;
    }
    if (options.baseDB) {
      this.manager = options.baseDB.manager;
    } else {
      this.manager = options.manager;
    }
    this.connected = this.manager.connected;
  }

  /**
   * Get a value for a path.
   *
   * @param path: the path for the object.
   *
   * @returns an `IObservable`.
   */
  get(path: string): IObservable | undefined {
    return this._baseDB.get(this._resolvePath(path));
  }

  /**
   * Whether the `IModelDB` has an object at this path.
   *
   * @param path: the path for the object.
   *
   * @returns a boolean for whether an object is at `path`.
   */
  has(path: string): boolean {
    return this._baseDB.has(this._resolvePath(path));
  }

  /**
   * Create a string and insert it in the database.
   *
   * @param path: the path for the string.
   *
   * @returns the string that was created.
   */
  createString(path: string): IObservableString {
    const schema = this._schemas[this._basePath];
    const field = schema.fields[path];
    if (!field || field.type !== 'text') {
      throw new Error(
        `Cannot create a string for path '${path}', incompatible with schema.`
      );
    }
    let str = new ObservableString(this.manager, schema, this._recordId, path);
    this._disposables.add(str);
    this.set(path, str);
    return str;
  }

  /**
   * Create an undoable list and insert it in the database.
   *
   * @param path: the path for the list.
   *
   * @returns the list that was created.
   *
   * #### Notes
   * The list can only store objects that are simple
   * JSON Objects and primitives.
   */
  createList<T extends ReadonlyJSONValue>(
    path: string
  ): IObservableUndoableList<T> {
    const schema = this._schemas[this._basePath];
    const field = schema.fields[path];
    if (!field || field.type !== 'list') {
      throw new Error(
        `Cannot create a list for path '${path}', incompatible with schema.`
      );
    }
    let vec = new ObservableUndoableList(
      this.manager,
      schema,
      path,
      this._recordId,
      new ObservableUndoableList.IdentitySerializer<T>()
    );
    this._disposables.add(vec);
    this.set(path, vec);
    return vec;
  }

  /**
   * Create a map and insert it in the database.
   *
   * @param path: the path for the map.
   *
   * @returns the map that was created.
   *
   * #### Notes
   * The map can only store objects that are simple
   * JSON Objects and primitives.
   */
  createMap(path: string): IObservableJSON {
    const schema = this._schemas[this._basePath];
    const field = schema.fields[path];
    if (!field || field.type !== 'map') {
      throw new Error(
        `Cannot create a map for path '${path}', incompatible with schema.`
      );
    }
    let map = new ObservableJSON(this.manager, schema, this._recordId, path);
    this._disposables.add(map);
    this.set(path, map);
    return map;
  }

  /**
   * Create an opaque value and insert it in the database.
   *
   * @param path: the path for the value.
   *
   * @returns the value that was created.
   */
  createValue(path: string): IObservableValue {
    const schema = this._schemas[this._basePath];
    const field = schema.fields[path];
    if (!field || field.type !== 'register') {
      throw new Error(
        `Cannot create a value for path '${path}', incompatible with schema.`
      );
    }
    let val = new ObservableValue(this.manager, schema, this._recordId, path);
    this._disposables.add(val);
    this.set(path, val);
    return val;
  }

  /**
   * Get a value at a path, or `undefined` if it has not been set
   * That value must already have been created using `createValue`.
   *
   * @param path: the path for the value.
   */
  getValue(path: string): ReadonlyJSONValue | undefined {
    const ds = this.manager.datastore!;
    if (ds === undefined) {
      throw new Error('Cannot use model db before connection completed!');
    }
    const schema = this._schemas[this._basePath];
    const record = ds.get(schema).get(this._recordId);
    return record && record[path];
  }

  /**
   * Set a value at a path. That value must already have
   * been created using `createValue`.
   *
   * @param path: the path for the value.
   *
   * @param value: the new value.
   */
  setValue(path: string, value: ReadonlyJSONValue): void {
    const ds = this.manager.datastore!;
    if (ds === undefined) {
      throw new Error('Cannot use model db before connection completed!');
    }
    const table = ds.get(this._schemas[this._basePath]);
    let oldValue = this.getValue(path);
    ds.beginTransaction();
    try {
      table.update({
        [this._recordId]: {
          [path]: {
            previous: oldValue,
            current: value
          }
        }
      } as any);
    } finally {
      ds.endTransaction();
    }
  }

  /**
   * Create a view onto a subtree of the model database.
   *
   * @param basePath: the path for the root of the subtree.
   *
   * @returns an `IModelDB` with a view onto the original
   *   `IModelDB`, with `basePath` prepended to all paths.
   */
  view(basePath: string): IModelDB {
    const schemas = toArray(iterValues(this._schemas));
    const manager = this.manager;
    // TODO: resolve path?
    return new DSModelDB({
      schemas,
      manager,
      basePath,
      baseDB: this,
      recordId: this._recordId
    });
  }

  /**
   * Set a value at a path. Not intended to
   * be called by user code, instead use the
   * `create*` factory methods.
   *
   * @param path: the path to set the value at.
   *
   * @param value: the value to set at the path.
   */
  set(path: string, value: IObservable): void {
    this._baseDB.set(this._resolvePath(path), value);
  }

  /**
   * Dispose of the resources held by the database.
   */
  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this._isDisposed = true;
    if (this._toDispose) {
      this._baseDB.dispose();
    }
    this._disposables.dispose();
  }

  /**
   * The base path for the `IModelDB`. This is prepended
   * to all the paths that are passed in to the member
   * functions of the object.
   */
  get basePath(): string {
    return this._basePath;
  }

  /**
   * Whether the database has been disposed.
   */
  get isDisposed(): boolean {
    return this._isDisposed;
  }

  /**
   * Whether the database has been populated
   * with model values prior to connection.
   */
  readonly isPrepopulated: boolean;

  /**
   * Whether the database is collaborative.
   */
  get isCollaborative(): true {
    return true;
  }

  /**
   * A promise that resolves when the database
   * has connected to its backend, if any.
   */
  readonly connected: Promise<void>;

  /**
   * A map of the currently active collaborators
   * for the database, including the local user.
   */
  readonly collaborators?: ICollaboratorMap;

  /**
   * The underlying datastore manager.
   */
  readonly manager: DatastoreManager;

  /**
   * Compute the fully resolved path for a path argument.
   */
  private _resolvePath(path: string): string {
    if (this._basePath) {
      path = this._basePath + '.' + path;
    }
    return path;
  }

  private _basePath: string;
  private _baseDB: DSModelDB | ObservableMap<IObservable>;
  private _schemas: { [key: string]: Schema };
  private _recordId: string;
  private _toDispose = false;
  private _isDisposed = false;
  private _disposables = new DisposableSet();
}

/**
 *
 */
export namespace DSModelDB {
  export interface ICreateOptions {
    schemas: ReadonlyArray<Schema>;
    manager: DatastoreManager;
    basePath?: string;
    baseDB?: DSModelDB;
    recordId: string;
  }
}
