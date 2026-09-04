import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  API,
  ElementFlags,
  SymbolFlags,
  TypeFlags,
} from 'typescript/unstable/sync';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = dirname(scriptDirectory);
const configPath = join(repositoryRoot, 'tsconfig.json');
const sourcePath = join(repositoryRoot, 'src/schema/artifacts.ts');
const outputDirectory = join(repositoryRoot, 'schemas/parser');
const checkOnly = process.argv.includes('--check');

// 根清单与根类型都来自同一份 TS 文件，生成器不维护第二份手写映射。
const { ARTIFACT_SCHEMA_ROOTS: roots } = await import(pathToFileURL(sourcePath).href);
const api = new API();
/** 每个根 schema 各自收集一次自引用类型：$defs 只放这份 schema 真的用到的定义。 */
const recursiveDefinitions = new Map();

try {
  const snapshot = api.updateSnapshot({ openProjects: [configPath] });
  try {
    const project = snapshot.getProject(configPath) ?? snapshot.getProjects()[0];
    if (project === undefined) {
      throw new Error(`TypeScript API 未载入 ${configPath}`);
    }
    const diagnostics = [
      ...project.program.getConfigFileParsingDiagnostics(),
      ...project.program.getProgramDiagnostics(),
      ...project.program.getSyntacticDiagnostics(),
      ...project.program.getBindDiagnostics(),
      ...project.program.getSemanticDiagnostics(),
    ];
    if (diagnostics.length > 0) {
      throw new Error(
        `TypeScript 诊断未通过：\n${diagnostics.map(formatDiagnostic).join('\n')}`,
      );
    }

    const checker = project.checker;
    const sourceFile = project.program.getSourceFile(sourcePath);
    if (sourceFile === undefined) {
      throw new Error(`TypeScript program 未载入 ${sourcePath}`);
    }

    const generated = new Map();
    for (const [fileName, typeName] of Object.entries(roots)) {
      const symbol = checker.resolveName(typeName, SymbolFlags.Type, sourceFile);
      if (symbol === undefined || checker.isUnknownSymbol(symbol)) {
        throw new Error(`ARTIFACT_SCHEMA_ROOTS 引用了不存在的类型 ${typeName}`);
      }
      const type = checker.getDeclaredTypeOfSymbol(symbol);
      recursiveDefinitions.clear();
      const schema = schemaForType(type, new Set());
      const definitions = resolveRecursiveDefinitions();
      generated.set(
        fileName,
        `${JSON.stringify({
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          $id: `https://pdf-parse.local/schemas/parser/${fileName}`,
          title: typeName,
          ...schema,
          ...(definitions === undefined ? {} : { $defs: definitions }),
        })}\n`,
      );
    }

    if (checkOnly) {
      await checkGenerated(generated);
    } else {
      await writeGenerated(generated);
    }

    function schemaForType(type, ancestors) {
      if ((type.flags & TypeFlags.Never) !== 0) {
        return false;
      }
      if ((type.flags & (TypeFlags.Any | TypeFlags.Unknown)) !== 0) {
        return {};
      }
      if ((type.flags & TypeFlags.StringLiteral) !== 0) {
        return { type: 'string', const: type.value };
      }
      if ((type.flags & TypeFlags.NumberLiteral) !== 0) {
        return { type: 'number', const: type.value };
      }
      if ((type.flags & TypeFlags.BooleanLiteral) !== 0) {
        return { type: 'boolean', const: booleanLiteralValue(type) };
      }
      if ((type.flags & TypeFlags.StringLike) !== 0) {
        return { type: 'string' };
      }
      if ((type.flags & TypeFlags.NumberLike) !== 0) {
        return { type: 'number' };
      }
      if ((type.flags & TypeFlags.BooleanLike) !== 0) {
        return { type: 'boolean' };
      }
      if ((type.flags & TypeFlags.Null) !== 0) {
        return { type: 'null' };
      }
      if ((type.flags & TypeFlags.Undefined) !== 0) {
        return {};
      }
      if (type.isUnionType()) {
        return unionSchema(type.getTypes(), ancestors);
      }
      if (checker.isTupleType(type)) {
        return tupleSchema(type, ancestors);
      }
      if (checker.isArrayLikeType(type)) {
        const numberIndex = checker
          .getIndexInfosOfType(type)
          .find((info) => (info.keyType.flags & TypeFlags.NumberLike) !== 0);
        return {
          type: 'array',
          items: numberIndex === undefined
            ? {}
            : schemaForType(numberIndex.valueType, ancestors),
        };
      }
      if (type.isObjectType() || type.isIntersectionType()) {
        return objectSchema(type, ancestors);
      }
      throw new Error(`不支持的 TypeScript 类型：${checker.typeToString(type)}`);
    }

    function unionSchema(types, ancestors) {
      const members = types.filter((type) => (type.flags & TypeFlags.Undefined) === 0);
      const literalValues = [];
      let literalKind;
      for (const member of members) {
        let kind;
        let value;
        if ((member.flags & TypeFlags.StringLiteral) !== 0) {
          kind = 'string';
          value = member.value;
        } else if ((member.flags & TypeFlags.NumberLiteral) !== 0) {
          kind = 'number';
          value = member.value;
        } else if ((member.flags & TypeFlags.BooleanLiteral) !== 0) {
          kind = 'boolean';
          value = booleanLiteralValue(member);
        } else {
          literalKind = undefined;
          literalValues.length = 0;
          break;
        }
        if (literalKind !== undefined && literalKind !== kind) {
          literalKind = undefined;
          literalValues.length = 0;
          break;
        }
        literalKind = kind;
        literalValues.push(value);
      }
      if (literalValues.length === members.length && literalKind !== undefined) {
        return { type: literalKind, enum: literalValues };
      }
      if (members.length === 1) {
        return schemaForType(members[0], ancestors);
      }
      return { anyOf: members.map((member) => schemaForType(member, ancestors)) };
    }

    function tupleSchema(type, ancestors) {
      const typeArguments = checker.getTypeArguments(type);
      const elementFlags = type.getTarget().elementFlags;
      const prefixItems = [];
      let restItems;
      let minimum = 0;
      for (let index = 0; index < typeArguments.length; index += 1) {
        const flag = elementFlags[index];
        if ((flag & ElementFlags.Rest) !== 0) {
          restItems = schemaForType(typeArguments[index], ancestors);
        } else {
          prefixItems.push(schemaForType(typeArguments[index], ancestors));
          if ((flag & ElementFlags.Required) !== 0) {
            minimum += 1;
          }
        }
      }
      return {
        type: 'array',
        prefixItems,
        minItems: minimum,
        ...(restItems === undefined
          ? { maxItems: prefixItems.length, items: false }
          : { items: restItems }),
      };
    }

    function booleanLiteralValue(type) {
      // typescript/unstable/sync 暴露的 intrinsicName 在 TS 7 中不再可靠；checker
      // 的规范字符串仍明确区分 true/false，避免把两个联合分支都生成 const:false。
      const printed = checker.typeToString(type);
      if (printed === 'true') return true;
      if (printed === 'false') return false;
      throw new Error(`无法解析布尔字面量：${printed}`);
    }

    /**
     * 自引用类型（大纲树）走 $defs：回边发出 $ref，定义体在根 schema 建完后补齐。
     * 展开成有限层数是另一种选择，但那会让"三层以内的大纲合法、第四层非法"，
     * 校验器就变成了一个隐形的深度限制。
     */
    function referenceRecursiveType(type) {
      const name = definitionName(type);
      recursiveDefinitions.set(name, type);
      return { $ref: `#/$defs/${name}` };
    }

    function definitionName(type) {
      const printed = checker.typeToString(type);
      // 匿名或重名类型退回带 id 的名字：$defs 的键必须唯一且可重现。
      return /^[A-Za-z_][A-Za-z0-9_]*$/.test(printed) ? printed : `type_${type.id}`;
    }

    function resolveRecursiveDefinitions() {
      if (recursiveDefinitions.size === 0) return undefined;
      const definitions = {};
      const built = new Set();
      let pending = [...recursiveDefinitions.entries()];
      while (pending.length > 0) {
        for (const [name, type] of pending) {
          if (built.has(name)) continue;
          built.add(name);
          // 直接建定义体：走 objectSchema 会先撞上自己的回边检查，产出一个只指向
          // 自己的空 $ref。自身预置进 ancestors，内部的自引用才落成 $ref。
          definitions[name] = objectSchemaBody(type, new Set([type.id]));
        }
        pending = [...recursiveDefinitions.entries()].filter(([name]) => !built.has(name));
      }
      return definitions;
    }

    function objectSchema(type, ancestors) {
      if (ancestors.has(type.id)) {
        return referenceRecursiveType(type);
      }
      return objectSchemaBody(type, ancestors);
    }

    function objectSchemaBody(type, ancestors) {
      const nextAncestors = new Set(ancestors);
      nextAncestors.add(type.id);

      const properties = {};
      const required = [];
      for (const property of checker.getPropertiesOfType(type)) {
        const propertyType = checker.getTypeOfSymbol(property);
        if (propertyType === undefined) {
          throw new Error(`无法解析属性类型：${property.name}`);
        }
        properties[property.name] = schemaForType(propertyType, nextAncestors);
        if ((property.flags & SymbolFlags.Optional) === 0) {
          required.push(property.name);
        }
      }

      const stringIndex = checker
        .getIndexInfosOfType(type)
        .find((info) => (info.keyType.flags & TypeFlags.StringLike) !== 0);
      return {
        type: 'object',
        properties,
        ...(required.length === 0 ? {} : { required }),
        additionalProperties:
          stringIndex === undefined
            ? false
            : schemaForType(stringIndex.valueType, nextAncestors),
      };
    }
  } finally {
    snapshot.dispose();
  }
} finally {
  api.close();
}

async function checkGenerated(generated) {
  const mismatches = [];
  for (const [fileName, expected] of generated) {
    const outputPath = join(outputDirectory, fileName);
    let actual;
    try {
      actual = await readFile(outputPath, 'utf8');
    } catch (error) {
      if (error !== null && typeof error === 'object' && error.code === 'ENOENT') {
        mismatches.push(`${fileName}: 缺失`);
        continue;
      }
      throw error;
    }
    if (actual !== expected) {
      mismatches.push(`${fileName}: 与 TypeScript 类型不一致`);
    }
  }
  if (mismatches.length > 0) {
    throw new Error(`JSON Schema 未同步：\n${mismatches.join('\n')}`);
  }
  console.error(`JSON Schema 已同步（${generated.size} 份）`);
}

async function writeGenerated(generated) {
  await mkdir(outputDirectory, { recursive: true });
  for (const [fileName, contents] of generated) {
    await writeFile(join(outputDirectory, fileName), contents, 'utf8');
  }
  console.error(
    `已从 ${relative(repositoryRoot, sourcePath)} 生成 ${generated.size} 份 JSON Schema`,
  );
}

function formatDiagnostic(diagnostic) {
  const location = diagnostic.fileName === undefined
    ? ''
    : `${relative(repositoryRoot, diagnostic.fileName)}:${diagnostic.start ?? 0}: `;
  return `${location}${flattenMessage(diagnostic.messageText)}`;
}

function flattenMessage(message) {
  if (typeof message === 'string') {
    return message;
  }
  const children = message.next?.map(flattenMessage).join(' ') ?? '';
  return `${message.messageText}${children === '' ? '' : ` ${children}`}`;
}
