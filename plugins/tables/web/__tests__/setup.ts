import '../../../../apps/web/src/extensions/index.js';
import { useExtensionsStore } from '../../../../apps/web/src/stores/extensions-store.js';
useExtensionsStore.setState({ extensions: [{ id: 'tables', name: 'Tables', description: null }], loaded: true });
