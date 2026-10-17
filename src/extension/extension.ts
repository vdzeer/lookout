import * as vscode from 'vscode';
import { Lookout } from './lookout';

export function activate(context: vscode.ExtensionContext) {
  const lookout = new Lookout(context);
  context.subscriptions.push(lookout);
  // The integration run reads state through this; users get nothing.
  return context.extensionMode === vscode.ExtensionMode.Production ? undefined : lookout.testApi();
}

export function deactivate(): void {
  // Everything is disposed through context.subscriptions.
}
