import yaml
import copy
from kubernetes import client, config
import argparse
import sys

def load_template(template_path):
    """Loads a multi-document YAML file."""
    with open(template_path, 'r') as f:
        return list(yaml.safe_load_all(f))

def get_available_vpn_configs(api_client, namespace, config_map_name):
    """Fetches VPN config names from a ConfigMap."""
    core_v1 = client.CoreV1Api(api_client)
    try:
        config_map = core_v1.read_namespaced_config_map(name=config_map_name, namespace=namespace)
        # Assumes VPN files in ConfigMap data end with .ovpn
        # The VPN_CONFIG env var should be the name without .ovpn
        vpn_names = [key.replace('.ovpn', '') for key in config_map.data.keys() if key.endswith('.ovpn')]
        if not vpn_names:
            print(f"Warning: No .ovpn files found in ConfigMap '{config_map_name}' data keys.")
        return vpn_names
    except client.ApiException as e:
        if e.status == 404:
            print(f"Error: ConfigMap '{config_map_name}' not found in namespace '{namespace}'.")
            print("Please ensure the ConfigMap containing VPN configurations exists and is correctly named.")
            print("The ConfigMap should have data entries like 'vpn1.ovpn: <config_content>', 'vpn2.ovpn: <config_content>', etc.")
        else:
            print(f"Error fetching ConfigMap '{config_map_name}': {e}")
        sys.exit(1)
    except AttributeError: # If config_map.data is None
        print(f"Error: ConfigMap '{config_map_name}' in namespace '{namespace}' has no data field or it\'s empty.")
        sys.exit(1)


def main():
    parser = argparse.ArgumentParser(description="Deploy multiple viewer instances with unique VPNs.")
    parser.add_argument("--stream-url", required=True, help="The Kick.com stream URL to view (e.g., https://kick.com/example_channel)")
    parser.add_argument("--num-deployments", type=int, required=True, help="Number of deployments to create.")
    parser.add_argument("--template-file", default="viewer-box-deployment.yaml", help="Path to the Kubernetes YAML template file.")
    parser.add_argument("--namespace", default="stream-viewers", help="Kubernetes namespace for deployments.")
    parser.add_argument("--vpn-configmap-name", default="vpn-configs", help="Name of the ConfigMap holding VPN configurations.")
    parser.add_argument("--replicas-per-deployment", type=int, default=1, help="Number of replicas for each deployment.")

    args = parser.parse_args()

    try:
        config.load_kube_config()
    except config.ConfigException:
        try:
            config.load_incluster_config()
        except config.ConfigException:
            print("Error: Could not load Kubernetes configuration. Ensure valid kubeconfig or running in-cluster.")
            sys.exit(1)
    
    k8s_api_client = client.ApiClient() # Use ApiClient for passing to API classes
    apps_v1_api = client.AppsV1Api(k8s_api_client)
    core_v1_api = client.CoreV1Api(k8s_api_client)

    templates = load_template(args.template_file)
    base_deployment_template = next((tpl for tpl in templates if tpl and tpl.get("kind") == "Deployment"), None)
    base_service_template = next((tpl for tpl in templates if tpl and tpl.get("kind") == "Service"), None)

    if not base_deployment_template:
        print(f"Error: Could not find a Deployment definition in '{args.template_file}'")
        sys.exit(1)

    available_vpns = get_available_vpn_configs(k8s_api_client, args.namespace, args.vpn_configmap_name)

    if not available_vpns:
        print(f"Error: No VPN configurations found in ConfigMap '{args.vpn_configmap_name}'. Cannot proceed.")
        sys.exit(1)

    if args.num_deployments > len(available_vpns):
        print(f"Error: Requested {args.num_deployments} deployments, but only {len(available_vpns)} VPNs available.")
        sys.exit(1)

    selected_vpns = available_vpns[:args.num_deployments]

    for i in range(args.num_deployments):
        vpn_config_name = selected_vpns[i]
        # Use a consistent suffix, e.g., instance number
        instance_suffix = f"-{i}" 
        
        # --- Prepare Deployment ---
        current_deployment = copy.deepcopy(base_deployment_template)
        
        original_deployment_name = current_deployment['metadata'].get('name', 'viewer-deployment')
        new_deployment_name = f"{original_deployment_name}{instance_suffix}"
        
        original_component_label = current_deployment['spec']['selector']['matchLabels'].get('component', 'viewer')
        new_component_label = f"{original_component_label}{instance_suffix}"

        current_deployment['metadata']['name'] = new_deployment_name
        current_deployment['metadata'].setdefault('labels', {})['deployment-instance'] = str(i)

        current_deployment['spec']['replicas'] = args.replicas_per_deployment
        
        current_deployment['spec']['selector']['matchLabels']['component'] = new_component_label
        current_deployment['spec']['selector']['matchLabels']['deployment-instance'] = str(i) # For unique selection

        current_deployment['spec']['template']['metadata'].setdefault('labels', {})
        current_deployment['spec']['template']['metadata']['labels']['component'] = new_component_label
        current_deployment['spec']['template']['metadata']['labels']['deployment-instance'] = str(i)


        container_updated = False
        for container in current_deployment['spec']['template']['spec']['containers']:
            if container['name'] == 'viewer-box':
                env_vars = container.get('env', [])
                # Update existing or add new
                env_map = {ev['name']: ev for ev in env_vars}

                env_map['BOX_NAME'] = {'name': 'BOX_NAME', 'value': f"box{instance_suffix}"}
                env_map['STREAM_URL'] = {'name': 'STREAM_URL', 'value': args.stream_url}
                env_map['VPN_CONFIG'] = {'name': 'VPN_CONFIG', 'value': vpn_config_name}
                
                container['env'] = list(env_map.values())
                container_updated = True
                break
        
        if not container_updated:
            print(f"Warning: Container 'viewer-box' not found in deployment {new_deployment_name}. Env vars not set.")

        try:
            apps_v1_api.create_namespaced_deployment(namespace=args.namespace, body=current_deployment)
            print(f"Deployment '{new_deployment_name}' created with VPN '{vpn_config_name}'.")
        except client.ApiException as e:
            if e.status == 409: # Conflict
                try:
                    apps_v1_api.replace_namespaced_deployment(name=new_deployment_name, namespace=args.namespace, body=current_deployment)
                    print(f"Deployment '{new_deployment_name}' replaced with VPN '{vpn_config_name}'.")
                except client.ApiException as e_replace:
                    print(f"Error replacing Deployment '{new_deployment_name}': {e_replace}")
            else:
                print(f"Error creating Deployment '{new_deployment_name}': {e}")

        # --- Prepare Service (if template exists) ---
        if base_service_template:
            current_service = copy.deepcopy(base_service_template)
            original_service_name = current_service['metadata'].get('name', 'viewer-service')
            new_service_name = f"{original_service_name}{instance_suffix}"

            current_service['metadata']['name'] = new_service_name
            current_service['metadata'].setdefault('labels', {})['deployment-instance'] = str(i)
            
            current_service['spec']['selector']['component'] = new_component_label
            current_service['spec']['selector']['deployment-instance'] = str(i) # Match pod labels

            try:
                core_v1_api.create_namespaced_service(namespace=args.namespace, body=current_service)
                print(f"Service '{new_service_name}' created.")
            except client.ApiException as e:
                if e.status == 409: # Conflict
                    # Service updates can be tricky. A common pattern is delete and recreate if changed,
                    # or patch. For simplicity, we'll just note it exists.
                    # You could implement replace_namespaced_service if needed.
                    print(f"Service '{new_service_name}' already exists. Skipping creation/update.")
                else:
                    print(f"Error creating Service '{new_service_name}': {e}")
        
        print("---")

    print(f"Successfully processed {args.num_deployments} deployments.")

if __name__ == '__main__':
    main() 