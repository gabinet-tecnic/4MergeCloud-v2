// PLYLoader local — Three.js r160 (font: unpkg.com/three@0.160.0)
import {
	BufferGeometry,
	FileLoader,
	Float32BufferAttribute,
	Loader,
	Color
} from '../three/three.module.js';

const _color = new Color();

class PLYLoader extends Loader {

	constructor( manager ) {
		super( manager );
		this.propertyNameMapping = {};
		this.customPropertyMapping = {};
	}

	load( url, onLoad, onProgress, onError ) {
		const scope = this;
		const loader = new FileLoader( this.manager );
		loader.setPath( this.path );
		loader.setResponseType( 'arraybuffer' );
		loader.setRequestHeader( this.requestHeader );
		loader.setWithCredentials( this.withCredentials );
		loader.load( url, function ( text ) {
			try {
				onLoad( scope.parse( text ) );
			} catch ( e ) {
				if ( onError ) onError( e );
				else console.error( e );
				scope.manager.itemError( url );
			}
		}, onProgress, onError );
	}

	setPropertyNameMapping( mapping ) { this.propertyNameMapping = mapping; }
	setCustomPropertyNameMapping( mapping ) { this.customPropertyMapping = mapping; }

	parse( data ) {

		function parseHeader( data, headerLength = 0 ) {
			const patternHeader = /^ply([\s\S]*)end_header(\r\n|\r|\n)/;
			let headerText = '';
			const result = patternHeader.exec( data );
			if ( result !== null ) headerText = result[ 1 ];

			const header = { comments: [], elements: [], headerLength, objInfo: '' };
			const lines = headerText.split( /\r\n|\r|\n/ );
			let currentElement;

			function make_ply_element_property( propertValues, propertyNameMapping ) {
				const property = { type: propertValues[ 0 ] };
				if ( property.type === 'list' ) {
					property.name = propertValues[ 3 ];
					property.countType = propertValues[ 1 ];
					property.itemType = propertValues[ 2 ];
				} else {
					property.name = propertValues[ 1 ];
				}
				if ( property.name in propertyNameMapping ) property.name = propertyNameMapping[ property.name ];
				return property;
			}

			for ( let i = 0; i < lines.length; i++ ) {
				let line = lines[ i ].trim();
				if ( line === '' ) continue;
				const lineValues = line.split( /\s+/ );
				const lineType = lineValues.shift();
				line = lineValues.join( ' ' );
				switch ( lineType ) {
					case 'format':   header.format = lineValues[0]; header.version = lineValues[1]; break;
					case 'comment':  header.comments.push( line ); break;
					case 'element':
						if ( currentElement !== undefined ) header.elements.push( currentElement );
						currentElement = { name: lineValues[0], count: parseInt( lineValues[1] ), properties: [] };
						break;
					case 'property': currentElement.properties.push( make_ply_element_property( lineValues, scope.propertyNameMapping ) ); break;
					case 'obj_info': header.objInfo = line; break;
					default: console.log( 'unhandled', lineType, lineValues );
				}
			}
			if ( currentElement !== undefined ) header.elements.push( currentElement );
			return header;
		}

		function parseASCIINumber( n, type ) {
			switch ( type ) {
				case 'char': case 'uchar': case 'short': case 'ushort': case 'int': case 'uint':
				case 'int8': case 'uint8': case 'int16': case 'uint16': case 'int32': case 'uint32':
					return parseInt( n );
				case 'float': case 'double': case 'float32': case 'float64':
					return parseFloat( n );
			}
		}

		function parseASCIIElement( properties, tokens ) {
			const element = {};
			for ( let i = 0; i < properties.length; i++ ) {
				if ( tokens.empty() ) return null;
				if ( properties[i].type === 'list' ) {
					const list = [];
					const n = parseASCIINumber( tokens.next(), properties[i].countType );
					for ( let j = 0; j < n; j++ ) {
						if ( tokens.empty() ) return null;
						list.push( parseASCIINumber( tokens.next(), properties[i].itemType ) );
					}
					element[ properties[i].name ] = list;
				} else {
					element[ properties[i].name ] = parseASCIINumber( tokens.next(), properties[i].type );
				}
			}
			return element;
		}

		function createBuffer() {
			const buffer = { indices:[], vertices:[], normals:[], uvs:[], faceVertexUvs:[], colors:[], faceVertexColors:[] };
			for ( const cp of Object.keys( scope.customPropertyMapping ) ) buffer[ cp ] = [];
			return buffer;
		}

		function mapElementAttributes( properties ) {
			const elementNames = properties.map( p => p.name );
			function findAttrName( names ) {
				for ( const name of names ) if ( elementNames.includes( name ) ) return name;
				return null;
			}
			return {
				attrX: findAttrName(['x','px','posx']) || 'x',
				attrY: findAttrName(['y','py','posy']) || 'y',
				attrZ: findAttrName(['z','pz','posz']) || 'z',
				attrNX: findAttrName(['nx','normalx']),
				attrNY: findAttrName(['ny','normaly']),
				attrNZ: findAttrName(['nz','normalz']),
				attrS: findAttrName(['s','u','texture_u','tx']),
				attrT: findAttrName(['t','v','texture_v','ty']),
				attrR: findAttrName(['red','diffuse_red','r','diffuse_r']),
				attrG: findAttrName(['green','diffuse_green','g','diffuse_g']),
				attrB: findAttrName(['blue','diffuse_blue','b','diffuse_b']),
			};
		}

		function parseASCII( data, header ) {
			const buffer = createBuffer();
			const patternBody = /end_header\s+(\S[\s\S]*\S|\S)\s*$/;
			let body;
			const matches = patternBody.exec( data );
			body = matches ? matches[1].split( /\s+/ ) : [];
			const tokens = new ArrayStream( body );
			loop: for ( let i = 0; i < header.elements.length; i++ ) {
				const elementDesc = header.elements[i];
				const attributeMap = mapElementAttributes( elementDesc.properties );
				for ( let j = 0; j < elementDesc.count; j++ ) {
					const element = parseASCIIElement( elementDesc.properties, tokens );
					if ( !element ) break loop;
					handleElement( buffer, elementDesc.name, element, attributeMap );
				}
			}
			return postProcess( buffer );
		}

		function postProcess( buffer ) {
			let geometry = new BufferGeometry();
			if ( buffer.indices.length > 0 ) geometry.setIndex( buffer.indices );
			geometry.setAttribute( 'position', new Float32BufferAttribute( buffer.vertices, 3 ) );
			if ( buffer.normals.length > 0 ) geometry.setAttribute( 'normal', new Float32BufferAttribute( buffer.normals, 3 ) );
			if ( buffer.uvs.length > 0 ) geometry.setAttribute( 'uv', new Float32BufferAttribute( buffer.uvs, 2 ) );
			if ( buffer.colors.length > 0 ) geometry.setAttribute( 'color', new Float32BufferAttribute( buffer.colors, 3 ) );
			if ( buffer.faceVertexUvs.length > 0 || buffer.faceVertexColors.length > 0 ) {
				geometry = geometry.toNonIndexed();
				if ( buffer.faceVertexUvs.length > 0 ) geometry.setAttribute( 'uv', new Float32BufferAttribute( buffer.faceVertexUvs, 2 ) );
				if ( buffer.faceVertexColors.length > 0 ) geometry.setAttribute( 'color', new Float32BufferAttribute( buffer.faceVertexColors, 3 ) );
			}
			for ( const cp of Object.keys( scope.customPropertyMapping ) ) {
				if ( buffer[cp].length > 0 ) geometry.setAttribute( cp, new Float32BufferAttribute( buffer[cp], scope.customPropertyMapping[cp].length ) );
			}
			geometry.computeBoundingSphere();
			return geometry;
		}

		function handleElement( buffer, elementName, element, cacheEntry ) {
			if ( elementName === 'vertex' ) {
				buffer.vertices.push( element[cacheEntry.attrX], element[cacheEntry.attrY], element[cacheEntry.attrZ] );
				if ( cacheEntry.attrNX && cacheEntry.attrNY && cacheEntry.attrNZ )
					buffer.normals.push( element[cacheEntry.attrNX], element[cacheEntry.attrNY], element[cacheEntry.attrNZ] );
				if ( cacheEntry.attrS && cacheEntry.attrT )
					buffer.uvs.push( element[cacheEntry.attrS], element[cacheEntry.attrT] );
				if ( cacheEntry.attrR !== null && cacheEntry.attrG !== null && cacheEntry.attrB !== null ) {
					_color.setRGB( element[cacheEntry.attrR]/255, element[cacheEntry.attrG]/255, element[cacheEntry.attrB]/255 ).convertSRGBToLinear();
					buffer.colors.push( _color.r, _color.g, _color.b );
				}
				for ( const cp of Object.keys( scope.customPropertyMapping ) )
					for ( const ep of scope.customPropertyMapping[cp] ) buffer[cp].push( element[ep] );
			} else if ( elementName === 'face' ) {
				const vertex_indices = element.vertex_indices || element.vertex_index;
				const texcoord = element.texcoord;
				if ( vertex_indices.length === 3 ) {
					buffer.indices.push( vertex_indices[0], vertex_indices[1], vertex_indices[2] );
					if ( texcoord && texcoord.length === 6 ) {
						buffer.faceVertexUvs.push( texcoord[0], texcoord[1], texcoord[2], texcoord[3], texcoord[4], texcoord[5] );
					}
				} else if ( vertex_indices.length === 4 ) {
					buffer.indices.push( vertex_indices[0], vertex_indices[1], vertex_indices[3] );
					buffer.indices.push( vertex_indices[1], vertex_indices[2], vertex_indices[3] );
				}
				if ( cacheEntry.attrR !== null && cacheEntry.attrG !== null && cacheEntry.attrB !== null ) {
					_color.setRGB( element[cacheEntry.attrR]/255, element[cacheEntry.attrG]/255, element[cacheEntry.attrB]/255 ).convertSRGBToLinear();
					buffer.faceVertexColors.push( _color.r,_color.g,_color.b, _color.r,_color.g,_color.b, _color.r,_color.g,_color.b );
				}
			}
		}

		function binaryReadElement( at, properties ) {
			const element = {};
			let read = 0;
			for ( let i = 0; i < properties.length; i++ ) {
				const property = properties[i];
				const valueReader = property.valueReader;
				if ( property.type === 'list' ) {
					const list = [];
					const n = property.countReader.read( at + read );
					read += property.countReader.size;
					for ( let j = 0; j < n; j++ ) { list.push( valueReader.read( at + read ) ); read += valueReader.size; }
					element[ property.name ] = list;
				} else {
					element[ property.name ] = valueReader.read( at + read );
					read += valueReader.size;
				}
			}
			return [ element, read ];
		}

		function setPropertyBinaryReaders( properties, body, little_endian ) {
			function getBinaryReader( dataview, type, le ) {
				switch ( type ) {
					case 'int8':   case 'char':   return { read: (at) => dataview.getInt8(at),              size: 1 };
					case 'uint8':  case 'uchar':  return { read: (at) => dataview.getUint8(at),             size: 1 };
					case 'int16':  case 'short':  return { read: (at) => dataview.getInt16(at,le),          size: 2 };
					case 'uint16': case 'ushort': return { read: (at) => dataview.getUint16(at,le),         size: 2 };
					case 'int32':  case 'int':    return { read: (at) => dataview.getInt32(at,le),          size: 4 };
					case 'uint32': case 'uint':   return { read: (at) => dataview.getUint32(at,le),         size: 4 };
					case 'float32':case 'float':  return { read: (at) => dataview.getFloat32(at,le),        size: 4 };
					case 'float64':case 'double': return { read: (at) => dataview.getFloat64(at,le),        size: 8 };
				}
			}
			for ( let i = 0; i < properties.length; i++ ) {
				const p = properties[i];
				if ( p.type === 'list' ) {
					p.countReader = getBinaryReader( body, p.countType, little_endian );
					p.valueReader = getBinaryReader( body, p.itemType,  little_endian );
				} else {
					p.valueReader = getBinaryReader( body, p.type, little_endian );
				}
			}
		}

		function parseBinary( data, header ) {
			const buffer = createBuffer();
			const little_endian = ( header.format === 'binary_little_endian' );
			const body = new DataView( data, header.headerLength );
			let loc = 0;
			for ( let ce = 0; ce < header.elements.length; ce++ ) {
				const elementDesc = header.elements[ce];
				const attributeMap = mapElementAttributes( elementDesc.properties );
				setPropertyBinaryReaders( elementDesc.properties, body, little_endian );
				for ( let cc = 0; cc < elementDesc.count; cc++ ) {
					const result = binaryReadElement( loc, elementDesc.properties );
					loc += result[1];
					handleElement( buffer, elementDesc.name, result[0], attributeMap );
				}
			}
			return postProcess( buffer );
		}

		function extractHeaderText( bytes ) {
			let i = 0, cont = true, line = '';
			const lines = [];
			const hasCRNL = /^ply\r\n/.test( new TextDecoder().decode( bytes.subarray(0,5) ) );
			do {
				const c = String.fromCharCode( bytes[i++] );
				if ( c !== '\n' && c !== '\r' ) {
					line += c;
				} else {
					if ( line === 'end_header' ) cont = false;
					if ( line !== '' ) { lines.push(line); line = ''; }
				}
			} while ( cont && i < bytes.length );
			if ( hasCRNL ) i++;
			return { headerText: lines.join('\r') + '\r', headerLength: i };
		}

		const scope = this;
		let geometry;

		if ( data instanceof ArrayBuffer ) {
			const bytes = new Uint8Array( data );
			const { headerText, headerLength } = extractHeaderText( bytes );
			const header = parseHeader( headerText, headerLength );
			if ( header.format === 'ascii' ) {
				geometry = parseASCII( new TextDecoder().decode(bytes), header );
			} else {
				geometry = parseBinary( data, header );
			}
		} else {
			geometry = parseASCII( data, parseHeader(data) );
		}

		return geometry;
	}
}

class ArrayStream {
	constructor( arr ) { this.arr = arr; this.i = 0; }
	empty() { return this.i >= this.arr.length; }
	next()  { return this.arr[ this.i++ ]; }
}

export { PLYLoader };
