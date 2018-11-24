import fs from 'fs-extra';
import { ToArrayBuffer } from './utils';


export enum ReaderEndian {
	LittleEndian = 1,
	BigEndian = 2
}

/**
 * Generic interface for reading data
 */
export abstract class Reader {

	/**
	 * Should clean up the reader and make it unusable
	 */
	abstract close(): Promise<void>;

	/**
	 * Retrieves the current position of the reader
	 */
	abstract pos(): number;

	/**
	 * Gets the total size of the reader. If it isn't trivial to figure out, then this can be very expensive
	 */
	abstract length(): Promise<number>;

	/**
	 * Changes the absolute position of the reader 
	 */
	abstract seek(pos: number): void;

	/**
	 * Abvances the current reader postition by this amount
	 */
	skip(count: number): void {
		this.seek(this.pos() + count);
	}

	/**
	 * Should get a new reader which is independently seekable and optionally follows the given positioning constraints
	 */
	abstract slice(start?: number, end?: number): Reader;

	/**
	 * Gets a list of bytes at the current position
	 */
	abstract readBytes(len: number): Promise<ArrayBuffer>;

	abstract readUint8(): Promise<number>;
	abstract readUint16(): Promise<number>;
	abstract readUint24(): Promise<number>;
	abstract readUint32(): Promise<number>;
	abstract readUint64(): Promise<number>;


	async readStringU16(len: number): Promise<string> {
		let buf = Buffer.from(await this.readBytes(len*2));
		return buf.toString('utf16le');
	}

}

/**
 * Simple helper class for implementing a reader on top of a type that can read a node.js Buffer efficiently
 */
export abstract class BufferBasedReader extends Reader {

	abstract readBufferBytes(count: number): Promise<Buffer>;

	async readBytes(n: number): Promise<ArrayBuffer> {
		let buf = await this.readBufferBytes(n);
		return ToArrayBuffer(buf);
	}

	async readUint8() {
		return (await this.readBufferBytes(1)).readUInt8(0);
	}

	async readUint16() {
		return (await this.readBufferBytes(2)).readUInt16LE(0);
	}

	async readUint24() {
		return (await this.readBufferBytes(3)).readUIntLE(0, 3);
	}

	async readUint32() {
		return (await this.readBufferBytes(4)).readUInt32LE(0);
	}

	async readUint64() {
		let n = (await this.readBufferBytes(6)).readUIntLE(0, 6);
		this.skip(2);
		return n;
	}

}

interface ReferenceCountedNumber {
	val: number;
	nrefs: number;
}


// TODO: Mainly needs the fd to be reference counted and we need to implement endianness choice
export class FileReader extends BufferBasedReader {

	private _fd: ReferenceCountedNumber;
	private _pos: number;

	private _start: number;
	private _end: number;
	//private _len: number;

	static async Create(filename: string) {
		let fd = await fs.open(filename, 'r');
		let stat = await fs.fstat(fd);
		return new FileReader({ val: fd, nrefs: 1 }, 0, stat.size);
	}

	private constructor(fd: ReferenceCountedNumber, start: number, end: number) {
		super();
		this._pos = start;
		this._fd = fd;
		this._start = start;
		this._end = end;
	}

	async length() {
		return this._end - this._start;
	}

	pos() {
		return this._pos - this._start;
	}

	seek(pos: number) {
		this._pos = pos;
	}

	slice(start?: number, end?: number) {
		// TODO: Main issue with this right now is that it doesn't reference count closes
		// TODO: bounds check the offsets given?
		this._fd.nrefs++;
		return new FileReader(this._fd, this._start + (start || 0), end? this._start + end : this._end);
	}

	async readBufferBytes(n : number): Promise<Buffer> {
		var buf = Buffer.allocUnsafe(n);
		if(this._pos + n > this._end) {
			throw new Error('Overrunning file');
		}

		let res = await fs.read(this._fd.val, buf, 0, n, this._pos);
		if(res.bytesRead !== n) {
			throw new Error('Failed to read all bytes from file');
		}

		this._pos += n;
		return buf;
	}

	async close() {
		this._fd.nrefs--;
		if(this._fd.nrefs === 0) {
			await fs.close(this._fd.val);
			this._fd.val = -1;
		}
	}

}


export class DataViewReader extends Reader {
	_view: DataView;
	_littleEndian: boolean;

	_pos = 0;

	constructor(buf: ArrayBuffer|Buffer, endian: ReaderEndian) {
		super();

		// Get Node.js Buffer's underlying ArrayBuffer
		if(buf instanceof Buffer) {
			buf = ToArrayBuffer(buf);
		}

		this._view = new DataView(buf);
		this._littleEndian = endian === ReaderEndian.LittleEndian;
	}

	// Nicely handled by the gargabe collector
	async close() { }

	pos() {
		return this._pos;
	}

	seek(n: number) {
		this._pos = n;
	}

	slice(start?: number, end?: number) {
		return new DataViewReader(
			this._view.buffer.slice(start || 0, end),
			this._littleEndian? ReaderEndian.LittleEndian : ReaderEndian.BigEndian
		);
	}

	async length() {
		return this._view.byteLength;
	}
	
	async readBytes(n: number) {
		let arr = this._view.buffer.slice(this._pos, this._pos + n);
		if(arr.byteLength !== n) {
			throw new Error('Overflowed buffer');
		}

		this._pos += n;

		return arr;
	}

	async readUint8() {
		const val = this._view.getUint8(this._pos); this._pos += 1;
		return val;
	}

	async readUint16() {
		const val = this._view.getUint16(this._pos, this._littleEndian); this._pos += 2;
		return val;
	}

	async readUint24() {
		let arr = new ArrayBuffer(4);
		let view = new DataView(arr);
		view.setUint32(0, 0); // Clear the buffer

		let off = this._littleEndian? 0 : 1;
		for(let i = 0; i < 3; i++) {
			view.setUint8(off + i, this._view.getUint8(this._pos++));
		}

		return view.getUint32(0, this._littleEndian);
	}

	async readUint32() {
		const val = this._view.getUint32(this._pos, this._littleEndian); this._pos += 4;
		return val;
	}

	async readUint64() {
		let buf = Buffer.from(await this.readBytes(8));
		return buf.readUIntLE(0, 6);
		
		// NOTE: We assume that we are never dealing with values with more than 48bits of integer precision
		const val = this._view.getFloat64(this._pos, this._littleEndian); this._pos += 8;
		return val;
	}

}