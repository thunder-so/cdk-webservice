# CDK Web Service

<p>
    <a href="https://github.com/thunder-so/cdk-webservice/actions/workflows/publish.yml"><img alt="Build" src="https://img.shields.io/github/actions/workflow/status/thunder-so/cdk-webservice/publish.yml?logo=github" /></a>
    <a href="https://www.npmjs.com/package/@thunderso/cdk-webservice"><img alt="Version" src="https://img.shields.io/npm/v/@thunderso/cdk-webservice.svg" /></a>
    <a href="https://www.npmjs.com/package/@thunderso/cdk-webservice"><img alt="Downloads" src="https://img.shields.io/npm/dm/@thunderso/cdk-webservice.svg"></a>
    <a href="https://www.npmjs.com/package/@thunderso/cdk-webservice"><img alt="License" src="https://img.shields.io/npm/l/@thunderso/cdk-webservice.svg" /></a>
</p>

Deploy containerized web services on AWS Fargate with an Application Load Balancer, using AWS CDK. 

Supports custom domains, environment variables, secrets, and CI/CD with GitHub Actions.


## Features

- Deploy any web service as a Docker container to [AWS Fargate](https://aws.amazon.com/fargate/)
- Automatic [VPC](https://aws.amazon.com/vpc/) and [ECS Cluster](https://aws.amazon.com/ecs/) creation
- [Application Load Balancer (ALB)](https://aws.amazon.com/elasticloadbalancing/application-load-balancer/) with public DNS
- Environment variables and [AWS Secrets Manager](https://aws.amazon.com/secrets-manager/) integration
- Custom domain and SSL via [Route53](https://aws.amazon.com/route53/) and [Certificate Manager](https://aws.amazon.com/certificate-manager/)
- CI/CD ready with [Github Actions](https://docs.github.com/en/actions)


## Prerequisites

You need an [AWS account](https://aws.amazon.com/premiumsupport/knowledge-center/create-and-activate-aws-account/) to create and deploy the required resources for the site on AWS.

Before you begin, make sure you have the following:
  - Node.js and npm: Ensure you have Node.js (v20 or later) and npm installed.
  - AWS CLI: Install and configure the AWS Command Line Interface.

  - AWS CDK: Install the AWS CDK globally
```
npm install -g aws-cdk
```

  - Before deploying, bootstrap your AWS environment:
```
cdk bootstrap aws://your-aws-account-id/us-east-1
```

This package uses the `npm` package manager and is an ES6+ Module.

# Nixpacks Integration

You can use [Nixpacks](https://nixpacks.com/) to build your container images automatically. To enable Nixpacks, set `buildProps.buildSystem` to `'Nixpacks'` in your `WebServiceProps` configuration:

```ts
const svcProps: WebServiceProps = {
  // ... other props
  buildProps: {
    buildSystem: 'Nixpacks',
    installcmd: 'pnpm install', // optional
    buildcmd: 'pnpm run build', // optional
    startcmd: 'pnpm start',     // optional
    environment: [
      { NODE_ENV: 'production' }
    ],
    secrets: [
      { key: 'DB_URL', resource: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:/my-app/DB_URL-abc123' }
    ]
  },
};
```

When enabled, the pipeline will:

- Install Nixpacks in the CodeBuild environment
- Generate a Dockerfile using Nixpacks
- Build and push the image to ECR
- Deploy the image to ECS Fargate

You can customize install, build, and start commands using the respective properties. If not set, Nixpacks will auto-detect the best commands for your project.

For more advanced usage, see the [Nixpacks documentation](https://nixpacks.com/docs/usage/configuration).


## Installation

Navigate to your project directory and install the package and its required dependencies:

```bash
npm i tsx @thunderso/cdk-webservice --save-dev
```

## Setup

1. Login into the AWS console and note the `Account ID`. You will need it in the configuration step.

2. Run the following commands to create the required CDK stack entrypoint at `stack/index.ts`. 

```bash
mkdir stack
cd stack
touch index.ts 
```

You should adapt the file to your project's needs.

> [!NOTE]
> Use different filenames such as `production.ts` and `dev.ts` for environments.


## Configuration

```ts
// stack/index.ts
import { Cdk, WebServiceStack, type WebServiceProps } from "@thunderso/cdk-webservice";

const svcProps: WebServiceProps = {
  env: {
    account: 'your-account-id',
    region: 'us-west-2'
  },
  application: 'your-application-id',
  service: 'your-service-id',
  environment: 'production',

  rootDir: '', // supports monorepos. e.g. app/

  // ... other props
};

new WebServiceStack(
  new Cdk.App(), 
  `${svcProps.application}-${svcProps.service}-${svcProps.environment}-stack`, 
  svcProps
);
```


# Deploy

Run `npm run build` before you deploy.

By running the following script, the CDK stack will be deployed to AWS.

```bash
npx cdk deploy --all --app="npx tsx stack/index.ts" 
```

After deployment, the stack outputs the public DNS name of the Application Load Balancer:

```
Outputs:
  LoadBalancerDNS: <your-load-balancer-url>
```


## Deploy using GitHub Actions

In your GitHub repository, add a new workflow file under `.github/workflows/deploy.yml` with the following content:

```yaml
name: Deploy WebService to AWS

on:
  push:

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '20'
      - run: npm ci
      - run: npm run build # if you have a build step
      - run: npx cdk deploy --require-approval never --all --app="npx tsx stack/index.ts"
        env:
          AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
```

Add `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` as repository secrets in GitHub.


## Destroy the Stack

If you want to destroy the stack and all its resources (including storage, e.g., access logs), run the following script:

```bash
npx cdk destroy --all --app="npx tsx stack/index.ts" 
```


# Manage Domain with Route53

1. [Create a hosted zone in Route53](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/AboutHZWorkingWith.html) for the desired domain, if you don't have one yet.

  This is required to create DNS records for the domain to make the app publicly available on that domain. On the hosted zone details you should see the `Hosted zone ID` of the hosted zone.

2. [Request a public regional certificate in the AWS Certificate Manager (ACM)](https://docs.aws.amazon.com/acm/latest/userguide/gs-acm-request-public.html) for the desired domain in the same region as the service and validate it, if you don't have one yet.

  This is required to provide the app via HTTPS on the public internet. Take note of the displayed `ARN` for the certificate. 

> [!IMPORTANT]
> The certificate must be issued in the same region as the service.

```ts
// stack/index.ts
const svcProps: WebServiceProps = {
  // ... other props

  domain: 'api.example.com',
  hostedZoneId: 'XXXXXXXXXXXXXXX',
  regionalCertificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/abcd1234-abcd-1234-abcd-1234abcd1234',
};
```


# Configure the Service

Each configuration property provides a means to fine-tune the performance and operational characteristics.

```ts
// stack/index.ts
import { CpuArchitecture } from 'aws-cdk-lib/aws-ecs';

const svcProps: WebServiceProps = {
  // ... other props

  serviceProps: {
    // ... other props
    dockerFile: 'Dockerfile',
    architecture: CpuArchitecture.ARM64,
    desiredCount: 1,
    cpu: 256,
    memorySize: 512,
    port: 3000,
  },
};
```

### `dockerFile`
Path to your Dockerfile relative to your project directory.  
- **Type**: `text`
- **Examples**: `Dockerfile.bun`, `dir/Dockerfile`,
- **Default**: Looks for a `Dockerfile` in the root directory.

### `architecture`
Defines the instruction set architecture for the task.
- **Type**: `CpuArchitecture`
- **Examples**: `CpuArchitecture.ARM64`, `CpuArchitecture.X86_64`
- **Default**: The architecture defaults to `CpuArchitecture.ARM64`.

### `desiredCount`
Specifies the number of container instances of your service to run.
- **Type**: `number`
- **Examples**: `1`, `2`, `3`
- **Default**: `1`

### `cpu`
The amount of CPU units to allocate to the container (per task).
- **Type**: `number`
- **Examples**: `256`, `512`, `1024`
- **Default**: `256`

### `memorySize`
The amount of memory (in MiB) to allocate to the container (per task).
- **Type**: `number`
- **Examples**: `512`, `1024`, `2048`
- **Default**: `512`

### `port`
The port number on which your container listens for incoming traffic.
- **Type**: `number`
- **Examples**: `4321`, `3000`, `8080`
- **Default**: `3000`


## Environment variables

Pass environment variables to your service by:

1. `variables`: Array of key-value pairs for plain environment variables.

2. `secrets`: Array of objects with `key` and `resource` (Secrets Manager ARN). The library automatically adds permissions for Lambda to read these secrets.

To create a plaintext secret in AWS Secrets Manager using the AWS CLI:

```bash
aws secretsmanager create-secret --name "your-secret-name" --secret-string "your-secret-value"
```

```ts
// stack/index.ts
const svcProps: WebServiceProps = {
  serviceProps: {
    // ... other props

    variables: [
      { PUBLIC_FRONTEND_URL: 'https://example.com' },
      { PUBLIC_ANALYTICS_ID: 'UA-XXXXXX' }
    ],

    secrets: [
      { 
        key: 'DB_URL', 
        resource: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:/my-app/DB_URL-abc123' 
      },
      { 
        key: 'DB_KEY', 
        resource: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:/my-app/DB_KEY-def456' 
      },
    ],
  },
};
```

# Docker example

Here is an example `Dockerfile` which can serve any Node application:

```Dockerfile
# ---- Build Stage ----
FROM public.ecr.aws/docker/library/node:22-alpine AS builder

WORKDIR /app

# Copy all files
COPY . .

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Install dependencies
RUN pnpm install

# Build Next.js app
RUN pnpm run build

# ---- Production Stage ----
FROM public.ecr.aws/docker/library/node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

# Install pnpm in production image
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy only necessary files from builder
COPY --from=builder /app/ ./

EXPOSE 3000

CMD ["pnpm", "start"]
```

You might want to add a `.dockerignore` to minimize the context size:

```
.DS_Store
.git
.gitignore
node_modules
stack
cdk.out
```

# Cost

Below are estimated AWS costs for a typical deployment of this stack. 

Example: Next.js container in `us-east-1` with default configuration.

## Baseline Cost (No Users, Always-On Service)

| Component         | Monthly Cost (No Free Tier) |
|-------------------|----------------------------|
| Fargate (1 task)  | ~$9                        |
| ALB               | ~$22                       |
| ECR               | $0 (first 500MB free)      |
| VPC/Subnets       | $0                         |
| CloudWatch Logs   | <$1                        |
| Route53           | $0.50                      |
| ACM (SSL)         | $0                         |
| Data Transfer     | $0 (first 100GB free)      |
| **Total**         | **~$33/month**             |

- **With Free Tier:** $0 (if eligible, for 12 months, and under limits)
- **Without Free Tier:** ~$33/month

## 1000 Daily Active Users (DAU) Estimate

Assumptions:
- Each user visits once/day, 5 pageviews, 500KB/page (2.5MB/user/day)
- Total data: 2.5GB/day, ~75GB/month
- ALB: 1 LCU covers up to 25 new connections/sec, 3,000 active connections, 5Gbps, or 1M requests/hour (well within 1 LCU for 1000 DAU)
- 2 Fargate tasks for redundancy

| Component         | Monthly Cost (No Free Tier) |
|-------------------|----------------------------|
| Fargate (2 tasks) | ~$18                       |
| ALB               | ~$22                       |
| ECR               | $0                         |
| VPC/Subnets       | $0                         |
| CloudWatch Logs   | <$1                        |
| Route53           | $0.50                      |
| ACM (SSL)         | $0                         |
| Data Transfer     | ~$6.75 (75GB @ $0.09/GB)   |
| **Total**         | **~$47/month**             |

- **With Free Tier:** ~$41/month (if still eligible, and under 100GB data out)
- **Without Free Tier:** ~$47/month

### Notes
- These are estimates; actual costs may vary based on usage, region, and AWS pricing changes.
- If you add more tasks, NAT gateways, or use more storage/logs, costs will increase.
- For production, consider scaling, backups, and monitoring costs.

## Support

For help or feature requests, open an issue on [GitHub](https://github.com/thunder-so/cdk-webservice/issues).
