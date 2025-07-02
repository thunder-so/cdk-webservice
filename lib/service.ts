import { Duration, CfnOutput, RemovalPolicy } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Cluster, ContainerImage, FargateService, TaskDefinition, LogDriver, Protocol, Secret, Compatibility, CpuArchitecture } from 'aws-cdk-lib/aws-ecs';
import { Vpc, SubnetType } from 'aws-cdk-lib/aws-ec2';
import { ApplicationLoadBalancer, ApplicationProtocol, ApplicationTargetGroup, ListenerAction, TargetType } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Secret as SecretsManagerSecret } from 'aws-cdk-lib/aws-secretsmanager';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { HostedZone, ARecord, RecordTarget } from 'aws-cdk-lib/aws-route53';
import { LoadBalancerTarget } from 'aws-cdk-lib/aws-route53-targets';
import { Certificate } from 'aws-cdk-lib/aws-certificatemanager';
import { WebServiceProps } from '../stack/WebServiceProps';

export interface ServiceProps extends WebServiceProps {
  cpu: number,
  memory: number,
}

export class ServiceConstruct extends Construct {
  public readonly loadBalancerDnsName: string;
  public readonly clusterName: string;
  public readonly fargateService: FargateService;
  public readonly taskDefinition: TaskDefinition;
  public readonly targetGroup: ApplicationTargetGroup;

  constructor(scope: Construct, id: string, props: ServiceProps) {
    super(scope, id);

    // Set the resource prefix
    const resourceIdPrefix = `${props.application}-${props.service}-${props.environment}`.substring(0, 42);

    // VPC
    const vpc = new Vpc(this, 'Vpc', {
      vpcName: `${resourceIdPrefix}-vpc`,
      maxAzs: 2,
      subnetConfiguration: [
        { name: 'public', subnetType: SubnetType.PUBLIC }
      ]
    });

    // ECS Cluster
    const cluster = new Cluster(this, 'Cluster', {
      clusterName: `${resourceIdPrefix}-cluster`,
      vpc: vpc
    });

    // Log group for container logs
    const logGroup = new LogGroup(this, 'LogGroup', {
      logGroupName: `/webservice/${resourceIdPrefix}-logs`,
      retention: RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY
    });

    // Task Definition
    const taskDef = new TaskDefinition(this, 'Task', {
      compatibility: Compatibility.FARGATE,
      cpu: `${props.serviceProps?.cpu ?? 256}`,
      memoryMiB: `${props.serviceProps?.memorySize ?? 512}`,
      runtimePlatform: {
        cpuArchitecture: props.serviceProps?.architecture ?? CpuArchitecture.ARM64,
      },
    });

    // Container
    const container = taskDef.addContainer('Container', {
      containerName: `${props.service}-container`,
      image: ContainerImage.fromAsset(props.rootDir ?? '.', {
        file: props.serviceProps?.dockerFile,
        buildArgs: props.serviceProps?.dockerBuildArgs
          ? Object.fromEntries(
              props.serviceProps.dockerBuildArgs.map(arg => {
                const [key, value] = arg.split('=');
                return [key, value];
              })
            )
          : undefined,
      }),
      logging: LogDriver.awsLogs({ logGroup, streamPrefix: 'web' }),
      environment: props.serviceProps?.variables?.reduce((acc, obj) => ({ ...acc, ...obj }), {}) ?? {},
      secrets: props.serviceProps?.secrets
        ? Object.fromEntries(
            props.serviceProps.secrets.map(s => [
              s.key,
              Secret.fromSecretsManager(
                SecretsManagerSecret.fromSecretAttributes(this, `${s.key}Secret`, {
                  secretCompleteArn: s.resource
                })
              )
            ])
          ) as { [key: string]: Secret }
        : undefined,
      healthCheck: {
        command: [
          'CMD-SHELL',
          `nc -z localhost ${props.serviceProps?.port || 3000} || exit 1`
        ],
        interval: Duration.seconds(15),
        timeout: Duration.seconds(5),
        retries: 3,
        startPeriod: Duration.seconds(60),
      },
    });

    container.addPortMappings({ containerPort: props.serviceProps?.port || 3000, protocol: Protocol.TCP });

    // Fargate Service
    const service = new FargateService(this, 'FargateService', {
      serviceName: `${props.service}-service`,
      cluster,
      taskDefinition: taskDef,
      desiredCount: props.serviceProps?.desiredCount ?? 1,
      minHealthyPercent: 50,
      assignPublicIp: true,
      healthCheckGracePeriod: Duration.seconds(60),
      circuitBreaker: {
        enable: true,
      },
    });

    this.targetGroup = new ApplicationTargetGroup(this, 'targetGroup', {
      vpc: vpc,
      port: props.serviceProps?.port || 3000,
      protocol: ApplicationProtocol.HTTP,
      targetType: TargetType.IP,
      targetGroupName: `${resourceIdPrefix}-blue-tg`,
      healthCheck: {
        path: '/',
      },
    });

    service.attachToApplicationTargetGroup(this.targetGroup);

    // Application Load Balancer
    const lb = new ApplicationLoadBalancer(this, 'ALB', {
      loadBalancerName: resourceIdPrefix,
      vpc,
      internetFacing: true,
    });

    // Add HTTP listener (always)
    const listener = lb.addListener('Listener', {
      port: 80,
      open: true,
      protocol: ApplicationProtocol.HTTP,
      defaultAction: ListenerAction.forward([this.targetGroup]),
    });

    // Add HTTPS listener if domain and certificate are provided
    if (props.domain && props.hostedZoneId && props.regionalCertificateArn) {
      const hostedZone = HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
        hostedZoneId: props.hostedZoneId,
        zoneName: props.domain.split('.').slice(1).join('.'),
      });
      const certificate = Certificate.fromCertificateArn(this, 'Certificate', props.regionalCertificateArn);

      lb.addListener('HttpsListener', {
        port: 443,
        open: true,
        protocol: ApplicationProtocol.HTTPS,
        certificates: [certificate],
        defaultAction: ListenerAction.forward([this.targetGroup]),
      });

      // Redirect HTTP to HTTPS
      listener.addAction('HTTPRedirect', {
        action: ListenerAction.redirect({ protocol: 'HTTPS', port: '443' }),
      });

      // Route53 A record for custom domain
      new ARecord(this, 'AliasRecord', {
        zone: hostedZone,
        recordName: props.domain,
        target: RecordTarget.fromAlias(new LoadBalancerTarget(lb)),
      });
    }

    this.loadBalancerDnsName = lb.loadBalancerDnsName;
    this.clusterName = cluster.clusterName;
    this.fargateService = service;
    this.taskDefinition = taskDef;

    new CfnOutput(this, 'LoadBalancerDNS', {
      value: this.loadBalancerDnsName,
      description: 'The DNS name of the load balancer',
    });
  }
}