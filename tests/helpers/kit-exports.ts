/**
 * The export surface of an extension kit, as sorted lines (`name` for values,
 * `type Name` for type-only exports), read with the TypeScript compiler so
 * `export *` and re-exports resolve exactly as consumers see them.
 */
import ts from 'typescript';

export function kitExportNames(file: string, tsconfig: string): string[] {
  const config = ts.getParsedCommandLineOfConfigFile(tsconfig, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => {
      throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n'));
    },
  });
  if (!config) throw new Error(`Cannot read ${tsconfig}`);
  const program = ts.createProgram({ rootNames: [file], options: { ...config.options, noEmit: true } });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(file);
  if (!source) throw new Error(`Not in program: ${file}`);
  const moduleSymbol = checker.getSymbolAtLocation(source);
  if (!moduleSymbol) throw new Error(`${file} is not a module`);
  return checker
    .getExportsOfModule(moduleSymbol)
    .map((symbol) => {
      const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
      const isValue = (target.flags & ts.SymbolFlags.Value) !== 0;
      return isValue ? symbol.name : `type ${symbol.name}`;
    })
    .sort((a, b) => {
      // Locale-independent: the snapshot must not depend on the machine's collation.
      const ka = a.replace(/^type /, '').toLowerCase();
      const kb = b.replace(/^type /, '').toLowerCase();
      return ka < kb ? -1 : ka > kb ? 1 : a < b ? -1 : a > b ? 1 : 0;
    });
}
